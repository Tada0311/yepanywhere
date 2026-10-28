import { describe, expect, it, vi } from "vitest";
import {
  CodexThreadMetadataMonitor,
  type CodexThreadMetadataConnection,
  type CodexThreadMetadataNotification,
} from "../../../src/sdk/providers/codex-thread-metadata.js";
import type { Thread } from "../../../src/sdk/providers/codex-protocol/generated/v2/Thread.js";

function thread(
  id: string,
  options: { name?: string | null; preview?: string; cwd?: string } = {},
): Thread {
  return {
    id,
    name: options.name ?? null,
    preview: options.preview ?? `Prompt for ${id}`,
    cwd: options.cwd ?? "/workspace/project",
  } as Thread;
}

class FakeConnection implements CodexThreadMetadataConnection {
  readonly requests: { method: string; params: unknown }[] = [];
  private observer:
    | ((notification: CodexThreadMetadataNotification) => void)
    | null = null;
  private readonly notifications: CodexThreadMetadataNotification[] = [];
  private waiter:
    | {
        resolve: (notification: CodexThreadMetadataNotification) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private closed = false;

  constructor(
    private readonly handleRequest: (
      method: string,
      params: unknown,
    ) => unknown,
  ) {}

  async connect(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return (await this.handleRequest(method, params)) as T;
  }

  notify(): void {}

  setNotificationObserver(
    observer: ((notification: CodexThreadMetadataNotification) => void) | null,
  ): void {
    this.observer = observer;
  }

  async nextNotification(): Promise<CodexThreadMetadataNotification> {
    const queued = this.notifications.shift();
    if (queued) return queued;
    if (this.closed) throw new Error("closed");
    return await new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  emit(method: string, params?: unknown): void {
    const notification = { method, params };
    this.observer?.(notification);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(notification);
    } else {
      this.notifications.push(notification);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.waiter?.reject(new Error("closed"));
    this.waiter = undefined;
  }
}

describe("CodexThreadMetadataMonitor", () => {
  it("hydrates Codex-native names from state-only thread/list pages", async () => {
    const connection = new FakeConnection((method, params) => {
      if (method === "initialize") return {};
      if (method !== "thread/list") throw new Error(`Unexpected ${method}`);
      const archived = (params as { archived?: boolean }).archived === true;
      return {
        data: archived
          ? [thread("archived", { name: "Archived rename" })]
          : [thread("active", { name: "Current rename" })],
        nextCursor: null,
        backwardsCursor: null,
      };
    });
    const monitor = new CodexThreadMetadataMonitor({
      connectionFactory: async () => connection,
    });

    await monitor.start();

    expect(monitor.getTitleOverride("active")).toEqual({
      title: "Current rename",
      fullTitle: "Current rename",
    });
    expect(monitor.getTitleOverride("archived")).toEqual({
      title: "Archived rename",
      fullTitle: "Archived rename",
    });
    const lists = connection.requests.filter(
      (request) => request.method === "thread/list",
    );
    expect(lists).toHaveLength(2);
    expect(lists.map((request) => request.params)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ archived: false, useStateDbOnly: true }),
        expect.objectContaining({ archived: true, useStateDbOnly: true }),
      ]),
    );
    expect(
      connection.requests.some((request) =>
        ["thread/resume", "turn/start"].includes(request.method),
      ),
    ).toBe(false);

    await monitor.close();
  });

  it("updates in real time and falls back to the rollout preview when cleared", async () => {
    const connection = new FakeConnection((method) => {
      if (method === "initialize") return {};
      if (method === "thread/list") {
        return {
          data: [thread("thread-1", { preview: "Original prompt" })],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const monitor = new CodexThreadMetadataMonitor({
      connectionFactory: async () => connection,
    });
    const updates: { title: string; fullTitle: string }[] = [];
    monitor.subscribe((update) => {
      updates.push(update);
    });

    await monitor.start();
    connection.emit("thread/name/updated", {
      threadId: "thread-1",
      threadName: "Renamed in Codex App",
    });
    expect(monitor.getTitleOverride("thread-1")).toEqual({
      title: "Renamed in Codex App",
      fullTitle: "Renamed in Codex App",
    });

    connection.emit("thread/name/updated", { threadId: "thread-1" });
    expect(monitor.getTitleOverride("thread-1")).toBeNull();
    expect(updates).toMatchObject([
      {
        title: "Renamed in Codex App",
        fullTitle: "Renamed in Codex App",
      },
      {
        title: "Original prompt",
        fullTitle: "Original prompt",
      },
    ]);

    await monitor.close();
  });

  it("reads an unknown renamed thread without resuming it", async () => {
    const connection = new FakeConnection((method) => {
      if (method === "initialize") return {};
      if (method === "thread/list") {
        return {
          data: [],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      if (method === "thread/read") {
        return {
          thread: thread("new-thread", { name: "New Codex title" }),
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const monitor = new CodexThreadMetadataMonitor({
      connectionFactory: async () => connection,
    });

    await monitor.start();
    connection.emit("thread/name/updated", {
      threadId: "new-thread",
      threadName: "New Codex title",
    });

    await vi.waitFor(() => {
      expect(monitor.getTitleOverride("new-thread")?.fullTitle).toBe(
        "New Codex title",
      );
    });
    expect(connection.requests).toContainEqual({
      method: "thread/read",
      params: { threadId: "new-thread", includeTurns: false },
    });
    expect(
      connection.requests.some((request) => request.method === "thread/resume"),
    ).toBe(false);

    await monitor.close();
  });

  it("reconnects and refreshes titles cleared while disconnected", async () => {
    const firstConnection = new FakeConnection((method) => {
      if (method === "initialize") return {};
      if (method === "thread/list") {
        return {
          data: [
            thread("thread-1", {
              name: "Renamed before disconnect",
              preview: "Original prompt",
            }),
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const secondConnection = new FakeConnection((method) => {
      if (method === "initialize") return {};
      if (method === "thread/list") {
        return {
          data: [
            thread("thread-1", {
              name: null,
              preview: "Original prompt",
            }),
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const connections = [firstConnection, secondConnection];
    const monitor = new CodexThreadMetadataMonitor({
      connectionFactory: async () => connections.shift() ?? secondConnection,
      reconnectMinDelayMs: 1,
      reconnectMaxDelayMs: 5,
    });
    const updates: { title: string; fullTitle: string }[] = [];
    monitor.subscribe((update) => {
      updates.push(update);
    });

    await monitor.start();
    expect(monitor.getTitleOverride("thread-1")?.fullTitle).toBe(
      "Renamed before disconnect",
    );

    await firstConnection.close();
    await vi.waitFor(() => {
      expect(monitor.getTitleOverride("thread-1")).toBeNull();
    });

    expect(secondConnection.requests).toContainEqual(
      expect.objectContaining({ method: "thread/list" }),
    );
    expect(updates).toContainEqual({
      threadId: "thread-1",
      cwd: "/workspace/project",
      title: "Original prompt",
      fullTitle: "Original prompt",
    });
    expect(
      [...firstConnection.requests, ...secondConnection.requests].some(
        (request) =>
          request.method === "thread/resume" ||
          request.method === "thread/start" ||
          request.method === "turn/start",
      ),
    ).toBe(false);

    await monitor.close();
  });

  it("closes the connection after a partial startup failure", async () => {
    const connection = new FakeConnection((method) => {
      if (method === "initialize") return {};
      if (method === "thread/list") {
        throw new Error("catalog unavailable");
      }
      throw new Error(`Unexpected ${method}`);
    });
    const close = vi.spyOn(connection, "close");
    const monitor = new CodexThreadMetadataMonitor({
      connectionFactory: async () => connection,
    });

    await expect(monitor.start()).rejects.toThrow("catalog unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
