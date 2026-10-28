import { truncateSessionTitle } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import type {
  Thread,
  ThreadListParams,
  ThreadListResponse,
  ThreadNameUpdatedNotification,
  ThreadReadParams,
  ThreadReadResponse,
} from "./codex-protocol/index.js";

export interface CodexThreadTitleOverride {
  title: string;
  fullTitle: string;
}

export interface CodexThreadTitleUpdate extends CodexThreadTitleOverride {
  threadId: string;
  cwd: string;
}

export interface CodexThreadTitleResolver {
  getTitleOverride(threadId: string): CodexThreadTitleOverride | null;
}

export interface CodexThreadMetadataConnection {
  connect(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  setNotificationObserver(
    observer: ((notification: CodexThreadMetadataNotification) => void) | null,
  ): void;
  nextNotification(): Promise<CodexThreadMetadataNotification>;
  close(): Promise<void>;
}

export interface CodexThreadMetadataNotification {
  method: string;
  params?: unknown;
}

export interface CodexThreadMetadataMonitorOptions {
  connectionFactory: () => Promise<CodexThreadMetadataConnection>;
  pageSize?: number;
  maxPages?: number;
  maxEntries?: number;
  maxPendingReads?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

interface ThreadMetadataEntry {
  threadId: string;
  cwd: string;
  name: string | null;
  preview: string | null;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_PENDING_READS = 256;
const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

const INTERACTIVE_AND_SUBAGENT_SOURCE_KINDS: NonNullable<
  ThreadListParams["sourceKinds"]
> = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Maintains the Codex-native thread-name overlay from one read-only app-server
 * connection. It never resumes or starts a thread, so metadata observation
 * cannot acquire the writer lock used by Codex App.
 */
export class CodexThreadMetadataMonitor implements CodexThreadTitleResolver {
  private readonly connectionFactory: () => Promise<CodexThreadMetadataConnection>;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxEntries: number;
  private readonly maxPendingReads: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly entries = new Map<string, ThreadMetadataEntry>();
  private readonly listeners = new Set<
    (update: CodexThreadTitleUpdate) => void
  >();
  private readonly pendingReads = new Set<string>();
  private connection: CodexThreadMetadataConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(options: CodexThreadMetadataMonitorOptions) {
    this.connectionFactory = options.connectionFactory;
    this.pageSize = Math.max(
      1,
      Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE),
    );
    this.maxPages = Math.max(
      1,
      Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES),
    );
    this.maxEntries = Math.max(
      1,
      Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
    );
    this.maxPendingReads = Math.max(
      1,
      Math.floor(options.maxPendingReads ?? DEFAULT_MAX_PENDING_READS),
    );
    this.reconnectMinDelayMs = Math.max(
      1,
      Math.floor(options.reconnectMinDelayMs ?? DEFAULT_RECONNECT_MIN_DELAY_MS),
    );
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectMinDelayMs,
      Math.floor(options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS),
    );
  }

  getTitleOverride(threadId: string): CodexThreadTitleOverride | null {
    const name = this.entries.get(threadId)?.name;
    if (!name) return null;
    return {
      title: truncateSessionTitle(name) || name,
      fullTitle: name,
    };
  }

  subscribe(listener: (update: CodexThreadTitleUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.closed) return;
    this.startPromise ??= this.startInternal();
    return await this.startPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.pendingReads.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch((error) => {
      getLogger().debug(
        { error },
        "Failed to close Codex thread metadata connection",
      );
    });
    await this.drainPromise?.catch(() => {});
  }

  private async startInternal(): Promise<void> {
    try {
      await this.connectOnce();
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  private async connectOnce(): Promise<void> {
    const connection = await this.connectionFactory();
    if (this.closed) {
      await connection.close();
      return;
    }
    this.connection = connection;
    let notificationsReady = false;
    const bufferedNotifications: CodexThreadMetadataNotification[] = [];
    connection.setNotificationObserver((notification) => {
      if (
        notificationsReady &&
        this.connection === connection &&
        !this.closed
      ) {
        this.handleNotification(notification);
        return;
      }
      if (
        notification.method === "thread/name/updated" &&
        bufferedNotifications.length < this.maxEntries
      ) {
        bufferedNotifications.push(notification);
      }
    });

    try {
      await connection.connect();
      await connection.request("initialize", {
        clientInfo: {
          name: "yep-anywhere-thread-metadata",
          title: "YA Codex thread metadata",
          version: "dev",
        },
        capabilities: null,
      });
      connection.notify("initialized");
      this.drainPromise = this.drainNotifications(connection);

      const previousEntries = new Map(this.entries);
      const nextEntries = new Map<string, ThreadMetadataEntry>();
      await this.loadThreadPage(connection, false, nextEntries);
      await this.loadThreadPage(connection, true, nextEntries);
      for (const notification of bufferedNotifications) {
        this.applyBufferedNotification(nextEntries, notification);
      }
      this.entries.clear();
      for (const entry of nextEntries.values()) {
        this.entries.set(entry.threadId, entry);
      }
      notificationsReady = true;
      this.emitSnapshotChanges(previousEntries, this.entries);
      for (const notification of bufferedNotifications) {
        const threadId = this.notificationThreadId(notification);
        if (threadId && !this.entries.has(threadId)) {
          this.scheduleThreadRead(threadId);
        }
      }
      this.reconnectAttempt = 0;
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
      }
      connection.setNotificationObserver(null);
      await connection.close().catch((closeError) => {
        getLogger().debug(
          { error: closeError },
          "Failed to close partially initialized Codex metadata connection",
        );
      });
      throw error;
    }
  }

  private async loadThreadPage(
    connection: CodexThreadMetadataConnection,
    archived: boolean,
    entries: Map<string, ThreadMetadataEntry>,
  ): Promise<void> {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await connection.request<ThreadListResponse>(
        "thread/list",
        {
          cursor,
          limit: this.pageSize,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: INTERACTIVE_AND_SUBAGENT_SOURCE_KINDS,
          archived,
          useStateDbOnly: true,
        } satisfies ThreadListParams,
      );

      for (const thread of response.data) {
        this.applyThreadTo(entries, thread);
      }

      const nextCursor = normalizedText(response.nextCursor);
      if (!nextCursor) return;
      if (seenCursors.has(nextCursor)) {
        getLogger().warn(
          { archived, nextCursor },
          "Codex thread/list pagination repeated a cursor",
        );
        return;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    getLogger().warn(
      { archived, maxPages: this.maxPages },
      "Codex thread/list pagination reached its safety limit",
    );
  }

  private handleNotification(
    notification: CodexThreadMetadataNotification,
  ): void {
    if (notification.method !== "thread/name/updated") return;
    const threadId = this.notificationThreadId(notification);
    if (!threadId) return;

    const current = this.entries.get(threadId);
    if (!current) {
      this.scheduleThreadRead(threadId);
      return;
    }

    const params = notification.params as
      | ThreadNameUpdatedNotification
      | undefined;
    const name = normalizedText(params?.threadName);
    if (current.name === name) return;
    current.name = name;
    this.touch(current);
    this.emitResolvedTitle(current);
  }

  private scheduleThreadRead(threadId: string): void {
    if (
      this.pendingReads.has(threadId) ||
      this.pendingReads.size >= this.maxPendingReads
    ) {
      return;
    }
    this.pendingReads.add(threadId);
    void this.readThread(threadId).finally(() => {
      this.pendingReads.delete(threadId);
    });
  }

  private async readThread(threadId: string): Promise<void> {
    const connection = this.connection;
    if (!connection || this.closed) return;
    try {
      const response = await connection.request<ThreadReadResponse>(
        "thread/read",
        {
          threadId,
          includeTurns: false,
        } satisfies ThreadReadParams,
      );
      this.applyThread(response.thread, true);
    } catch (error) {
      getLogger().debug(
        { error, threadId },
        "Failed to read metadata for an unknown Codex thread",
      );
    }
  }

  private applyThread(thread: Thread, emitChange: boolean): void {
    const entry = this.threadMetadataEntry(thread);
    if (!entry) return;
    this.entries.set(entry.threadId, entry);
    this.touch(entry);
    if (emitChange) {
      this.emitResolvedTitle(entry);
    }
  }

  private applyThreadTo(
    entries: Map<string, ThreadMetadataEntry>,
    thread: Thread,
  ): void {
    const entry = this.threadMetadataEntry(thread);
    if (!entry) return;
    entries.delete(entry.threadId);
    entries.set(entry.threadId, entry);
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      entries.delete(oldest);
    }
  }

  private threadMetadataEntry(thread: Thread): ThreadMetadataEntry | null {
    const threadId = normalizedText(thread.id);
    const cwd = normalizedText(thread.cwd);
    if (!threadId || !cwd) return null;
    return {
      threadId,
      cwd,
      name: normalizedText(thread.name),
      preview: normalizedText(thread.preview),
    };
  }

  private notificationThreadId(
    notification: CodexThreadMetadataNotification,
  ): string | null {
    const params = notification.params as
      | ThreadNameUpdatedNotification
      | undefined;
    return normalizedText(params?.threadId);
  }

  private applyBufferedNotification(
    entries: Map<string, ThreadMetadataEntry>,
    notification: CodexThreadMetadataNotification,
  ): void {
    const threadId = this.notificationThreadId(notification);
    if (!threadId) return;
    const current = entries.get(threadId);
    if (!current) return;
    const params = notification.params as
      | ThreadNameUpdatedNotification
      | undefined;
    current.name = normalizedText(params?.threadName);
  }

  private emitSnapshotChanges(
    previousEntries: ReadonlyMap<string, ThreadMetadataEntry>,
    nextEntries: ReadonlyMap<string, ThreadMetadataEntry>,
  ): void {
    const threadIds = new Set([
      ...previousEntries.keys(),
      ...nextEntries.keys(),
    ]);
    for (const threadId of threadIds) {
      const previous = previousEntries.get(threadId);
      const next = nextEntries.get(threadId);
      if ((previous?.name ?? null) === (next?.name ?? null)) continue;
      if (next?.name) {
        this.emitTitleUpdate(next);
        continue;
      }
      const fallback = next ?? previous;
      if (fallback) this.emitResolvedTitle(fallback);
    }
  }

  private touch(entry: ThreadMetadataEntry): void {
    this.entries.delete(entry.threadId);
    this.entries.set(entry.threadId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  private emitResolvedTitle(entry: ThreadMetadataEntry): void {
    const fullTitle = entry.name ?? entry.preview;
    if (!fullTitle) return;
    this.emitTitleUpdate({
      ...entry,
      name: fullTitle,
    });
  }

  private emitTitleUpdate(entry: ThreadMetadataEntry): void {
    if (!entry.name) return;
    const update: CodexThreadTitleUpdate = {
      threadId: entry.threadId,
      cwd: entry.cwd,
      title: truncateSessionTitle(entry.name) || entry.name,
      fullTitle: entry.name,
    };
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (error) {
        getLogger().debug(
          { error, threadId: entry.threadId },
          "Codex thread title listener failed",
        );
      }
    }
  }

  private async drainNotifications(
    connection: CodexThreadMetadataConnection,
  ): Promise<void> {
    while (!this.closed) {
      try {
        await connection.nextNotification();
      } catch (error) {
        this.handleDisconnect(connection, error);
        return;
      }
    }
  }

  private handleDisconnect(
    connection: CodexThreadMetadataConnection,
    error: unknown,
  ): void {
    if (this.closed || this.connection !== connection) return;
    this.connection = null;
    connection.setNotificationObserver(null);
    getLogger().debug(
      { error },
      "Codex thread metadata connection closed; reconnecting",
    );
    void connection.close().catch((closeError) => {
      getLogger().debug(
        { error: closeError },
        "Failed to close disconnected Codex metadata connection",
      );
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectMinDelayMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.connection) return;
    try {
      await this.connectOnce();
    } catch (error) {
      getLogger().warn(
        { error },
        "Failed to reconnect Codex thread metadata monitor",
      );
      this.scheduleReconnect();
    }
  }
}
