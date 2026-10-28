import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  EffectiveSessionLaunchSettings,
  SessionLivenessSnapshot,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { UI_KEYS } from "../../lib/storageKeys";
import type {
  FileChangeEvent,
  ProcessStateEvent,
  SessionStatusEvent,
  SessionUpdatedEvent,
} from "../../lib/activityBus";
import { sessionModelPick } from "../../lib/sessionPickStorage";
import { getSessionActivityUiState } from "../../lib/sessionActivityUi";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import type { SessionStatus } from "../../types";
import { PENDING_SEND_RECONCILE_MS } from "../../lib/deliveryState";
import { __resetAwayRecapTimersForTest, useSession } from "../useSession";
import type { SessionLoadResult } from "../useSessionMessages";
import { DEFAULT_STREAM_DISPATCH_MIN_GAP_MS } from "../../lib/streamDispatchCoalescer";
import type { SessionWatchChangeEvent } from "../useSessionWatchStream";

const apiMocks = vi.hoisted(() => ({
  getAgentMappings: vi.fn(),
  getAgentSession: vi.fn(),
  getSessionMetadata: vi.fn(),
  requestRecap: vi.fn(),
  requestSessionRecap: vi.fn(),
  setPermissionMode: vi.fn(),
}));

const sessionMessagesMock = vi.hoisted(() => ({
  effectiveLaunchSettings: undefined as
    | EffectiveSessionLaunchSettings
    | undefined,
  messages: [] as Array<Record<string, unknown>>,
  loading: false,
  provider: "codex",
  sessionUpdatedAt: "2026-04-24T00:00:00.000Z",
  reconciledSessionUpdatedAt: "2026-04-24T00:00:00.000Z",
}));

const fetchNewMessages = vi.fn(async () => {});
const fetchSessionMetadata = vi.fn(async () => {});
const registerToolUseAgent = vi.fn();
const handleStreamSubagentMessage = vi.fn();
const mergeLoadedAgentContent = vi.fn();
const updateAgentContextUsage = vi.fn();
const clearAgentStreamingPlaceholders = vi.fn();
const clearStreamingPlaceholders = vi.fn();
const applyFinalMarkdownAugment = vi.fn();
const updateSession = vi.fn();

let fileActivityOptions:
  | {
      enabled?: boolean;
      onSessionStatusChange?: (event: SessionStatusEvent) => void;
      onSessionUpdated?: (event: SessionUpdatedEvent) => void;
      onFileChange?: (event: FileChangeEvent) => void;
      onProcessStateChange?: (event: ProcessStateEvent) => void;
      onReconnect?: () => void | Promise<void>;
    }
  | undefined;

let sessionWatchOptions:
  | {
      onChange?: (event: SessionWatchChangeEvent) => void;
      onOpen?: () => void;
      onReconnect?: () => void;
    }
  | undefined;
let sessionWatchTarget: { sessionId: string } | null | undefined;

let sessionStreamHandler:
  | ((data: { eventType: string; [key: string]: unknown }) => void)
  | null = null;
let sessionStreamSessionId: string | null | undefined;
let sessionStreamErrorHandler: (() => void | Promise<void>) | null = null;

// Stream events that arrive within the quiet gap of the previous one are
// coalesced (lib/streamDispatchCoalescer.ts). A test that emits several
// events at one fake instant settles the pending batch before asserting.
function settleStreamDispatch() {
  vi.advanceTimersByTime(DEFAULT_STREAM_DISPATCH_MIN_GAP_MS);
}

let streamingContentOptions:
  | {
      onAgentContextUsage?: (
        agentId: string,
        usage: { inputTokens: number; percentage: number },
      ) => void;
    }
  | undefined;

let sessionMessagesOptions:
  | {
      onLoadComplete?: (result: SessionLoadResult) => void;
      onLoadError?: (error: Error) => void;
      onTranscriptReconciled?: (updatedAt: string) => void;
    }
  | undefined;

const PROJECT_ID = "proj-1" as unknown as UrlProjectId;

function mockLiveness(
  overrides: Partial<SessionLivenessSnapshot> = {},
): SessionLivenessSnapshot {
  return {
    checkedAt: "2026-04-24T00:06:00.000Z",
    derivedStatus: "long-silent-unverified",
    activeWorkKind: "agent-turn",
    state: "in-turn",
    evidence: ["provider-message-stale"],
    lastProviderMessageAt: "2026-04-24T00:00:00.000Z",
    lastRawProviderEventAt: null,
    lastRawProviderEventSource: null,
    lastStateChangeAt: "2026-04-23T23:59:00.000Z",
    lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
    lastVerifiedIdleAt: null,
    lastLivenessProbeAt: null,
    lastLivenessProbeStatus: null,
    lastLivenessProbeSource: null,
    silenceMs: 360_000,
    longSilenceThresholdMs: 300_000,
    processAlive: true,
    queueDepth: 0,
    deferredQueueDepth: 0,
    ...overrides,
  };
}

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
      key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
      get length() {
        return store.size;
      },
    },
  });
}

function installVisibilityStateMock(initial: DocumentVisibilityState) {
  let visibilityState = initial;
  const descriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });

  return {
    set(value: DocumentVisibilityState) {
      visibilityState = value;
    },
    restore() {
      if (descriptor) {
        Object.defineProperty(document, "visibilityState", descriptor);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    },
  };
}

vi.mock("../useSessionMessages", () => ({
  useSessionMessages: vi.fn((options) => {
    sessionMessagesOptions = options;
    const reconciledAt = sessionMessagesMock.reconciledSessionUpdatedAt;
    // biome-ignore lint/correctness/useExhaustiveDependencies: Tests mutate this fixture watermark between rerenders to simulate async transcript completion.
    useEffect(() => {
      options.onTranscriptReconciled?.(reconciledAt);
    }, [options.onTranscriptReconciled, reconciledAt]);
    return {
      messages: sessionMessagesMock.messages,
      agentContent: {},
      toolUseToAgent: new Map(),
      markdownAugments: {},
      applyFinalMarkdownAugment,
      loading: sessionMessagesMock.loading,
      sessionLoadProgress: {
        stage: "complete",
        messageCount: sessionMessagesMock.messages.length,
        updatedAtMs: 0,
      },
      session: {
        id: "sess-1",
        projectId: "proj-1",
        provider: sessionMessagesMock.provider,
        model: "gpt-5.4",
        effectiveLaunchSettings: sessionMessagesMock.effectiveLaunchSettings,
        updatedAt: sessionMessagesMock.sessionUpdatedAt,
        messages: [],
      },
      updateSession,
      handleStreamingUpdate: vi.fn(),
      handleStreamMessageEvent: vi.fn(),
      flushPendingStreamMessage: vi.fn(),
      handleStreamSubagentMessage,
      registerToolUseAgent,
      mergeLoadedAgentContent,
      updateAgentContextUsage,
      clearAgentStreamingPlaceholders,
      clearStreamingPlaceholders,
      fetchNewMessages,
      fetchSessionMetadata,
      pagination: undefined,
      loadingOlder: false,
      olderLoadContinuationRequired: false,
      loadOlderMessages: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: vi.fn((options) => {
    fileActivityOptions = options;
  }),
}));

vi.mock("../useSessionStream", () => ({
  useSessionStream: vi.fn((sessionId, options) => {
    sessionStreamSessionId = sessionId;
    sessionStreamHandler = options.onMessage;
    sessionStreamErrorHandler = options.onError;
    return { connected: true, reconnect: vi.fn() };
  }),
}));

vi.mock("../useSessionWatchStream", () => ({
  useSessionWatchStream: vi.fn((target, options) => {
    sessionWatchTarget = target;
    sessionWatchOptions = options;
    return { connected: false };
  }),
}));

vi.mock("../useStreamingContent", () => ({
  useStreamingContent: vi.fn((options) => {
    streamingContentOptions = options;
    return {
      handleStreamEvent: vi.fn(() => false),
      clearStreaming: vi.fn(),
      cleanup: vi.fn(),
    };
  }),
}));

describe("useSession completion reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cleanup();
    __resetAwayRecapTimersForTest();
    vi.clearAllMocks();
    apiMocks.getAgentMappings.mockReset();
    apiMocks.getAgentMappings.mockResolvedValue({ mappings: [] });
    apiMocks.getAgentSession.mockReset();
    apiMocks.getAgentSession.mockResolvedValue({
      messages: [],
      status: "completed",
    });
    apiMocks.getSessionMetadata.mockReset();
    apiMocks.requestRecap.mockReset();
    apiMocks.requestRecap.mockResolvedValue({ supported: true });
    apiMocks.requestSessionRecap.mockReset();
    apiMocks.requestSessionRecap.mockResolvedValue({ supported: true });
    apiMocks.setPermissionMode.mockReset();
    apiMocks.setPermissionMode.mockResolvedValue({
      permissionMode: "acceptEdits",
      modeVersion: 1,
    });
    installLocalStorageMock();
    fileActivityOptions = undefined;
    sessionWatchOptions = undefined;
    sessionWatchTarget = undefined;
    sessionMessagesOptions = undefined;
    sessionStreamHandler = null;
    sessionStreamSessionId = undefined;
    sessionStreamErrorHandler = null;
    streamingContentOptions = undefined;
    sessionMessagesMock.messages = [];
    sessionMessagesMock.loading = false;
    sessionMessagesMock.provider = "codex";
    sessionMessagesMock.sessionUpdatedAt = "2026-04-24T00:00:00.000Z";
    sessionMessagesMock.reconciledSessionUpdatedAt = "2026-04-24T00:00:00.000Z";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes persisted messages when the live stream completes", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(sessionStreamHandler).not.toBeNull();

    act(() => {
      sessionStreamHandler?.({ eventType: "complete" });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.status).toEqual({ owner: "none" });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("catches up Codex persistence after the stream reconnects", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "connected",
        sessionId: "sess-1",
        state: "in-turn",
        provider: "codex",
      });
      settleStreamDispatch();
    });
    expect(fetchNewMessages).not.toHaveBeenCalled();

    act(() => {
      sessionStreamHandler?.({
        eventType: "connected",
        sessionId: "sess-1",
        state: "in-turn",
        provider: "codex",
      });
    });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("catches up durable messages when activity reports the turn idle", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      fileActivityOptions?.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        activity: "idle",
        timestamp: "2026-08-10T08:06:29.513Z",
      });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.status).toMatchObject({ owner: "self" });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(2);
  });

  it("deduplicates exact broad and focused file facts", () => {
    renderHook(() => useSession(PROJECT_ID, "sess-1", undefined));

    const path = "/tmp/sess-1.jsonl";
    act(() => {
      fileActivityOptions?.onFileChange?.({
        type: "file-change",
        provider: "codex",
        path,
        relativePath: "sess-1.jsonl",
        changeType: "modify",
        timestamp: "2026-08-08T17:00:00.010Z",
        mtimeMs: 1234.5,
        size: 100,
        fileType: "session",
      });
      sessionWatchOptions?.onChange?.({
        type: "session-watch-change",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        provider: "codex",
        path,
        source: "fs-watch",
        changeVersion: 7,
        sourceObservedAt: "2026-08-08T17:00:00.000Z",
        mtimeMs: 1234.5,
        size: 100,
        timestamp: "2026-08-08T17:00:00.012Z",
      });
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(100);
      sessionWatchOptions?.onChange?.({
        type: "session-watch-change",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        provider: "codex",
        path,
        source: "fs-watch",
        changeVersion: 8,
        sourceObservedAt: "2026-08-08T17:00:00.100Z",
        mtimeMs: 1235.5,
        size: 120,
        timestamp: "2026-08-08T17:00:00.112Z",
      });
      vi.advanceTimersByTime(400);
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fetchNewMessages).toHaveBeenCalledTimes(2);
  });

  it("catches up after the focused session watch reconnects", () => {
    renderHook(() => useSession(PROJECT_ID, "sess-1", undefined));

    act(() => {
      sessionWatchOptions?.onReconnect?.();
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("closes the initial snapshot-to-watch race when the watch opens", () => {
    renderHook(() => useSession(PROJECT_ID, "sess-1", undefined));

    act(() => {
      sessionWatchOptions?.onOpen?.();
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the pending initial load when the watch opens", () => {
    sessionMessagesMock.loading = true;
    renderHook(() => useSession(PROJECT_ID, "sess-1", undefined));

    act(() => {
      sessionWatchOptions?.onOpen?.();
      sessionWatchOptions?.onReconnect?.();
    });

    expect(fetchNewMessages).not.toHaveBeenCalled();
  });

  it("surfaces deferred effort configuration failures", () => {
    const onConfigurationError = vi.fn();
    renderHook(() =>
      useSession(
        PROJECT_ID,
        "sess-1",
        {
          owner: "self",
          processId: "proc-1",
        },
        undefined,
        { onConfigurationError },
      ),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "configuration-error",
        setting: "effort",
        requestedValue: "high",
        message: "queued work remains blocked",
      });
    });

    expect(onConfigurationError).toHaveBeenCalledWith({
      setting: "effort",
      requestedValue: "high",
      message: "queued work remains blocked",
    });
  });

  it("clears compacting state when the live stream completes", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
      settleStreamDispatch();
    });

    expect(result.current.isCompacting).toBe(true);

    act(() => {
      sessionStreamHandler?.({ eventType: "complete" });
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("refreshes persisted messages when ownership drops to none", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(fileActivityOptions?.onSessionStatusChange).toBeDefined();

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.status).toEqual({ owner: "none" });
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("clears compacting state when ownership drops to none", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("keeps known goal state when a live inventory does not report it", () => {
    const knownGoal = {
      name: "goal",
      description: "Set a goal",
      providerDetails: {
        codex: { goalObjective: "ship the fix", goalStatus: "active" },
      },
    };
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionMessagesOptions?.onLoadComplete?.({
        session: {
          id: "sess-1",
          projectId: PROJECT_ID,
          title: null,
          fullTitle: null,
          createdAt: "2026-04-23T23:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z",
          messageCount: 1,
          ownership: { owner: "self", processId: "proc-1" },
          provider: "codex",
        },
        status: { owner: "self", processId: "proc-1" },
        slashCommands: [knownGoal],
      });
    });

    // A process start or skills refresh reports the inventory before the
    // provider has said anything about the goal.
    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "init",
        slash_command_inventory: [
          { name: "goal", description: "Set a goal" },
          { name: "review", description: "Review changes" },
        ],
      });
      settleStreamDispatch();
    });

    expect(result.current.slashCommands).toEqual([
      knownGoal,
      { name: "review", description: "Review changes" },
    ]);

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "commands_changed",
        slash_command_inventory: [
          {
            name: "goal",
            description: "Set a goal",
            providerDetails: {
              codex: { goalObjective: null, goalStatus: null },
            },
          },
        ],
      });
      settleStreamDispatch();
    });

    expect(result.current.slashCommands).toEqual([
      {
        name: "goal",
        description: "Set a goal",
        providerDetails: { codex: { goalObjective: null, goalStatus: null } },
      },
    ]);
  });

  it("does not refresh for unrelated session status events", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "other-session",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(fetchNewMessages).not.toHaveBeenCalled();
  });

  it("hydrates reloaded pending task data through action wrappers", async () => {
    sessionMessagesMock.messages = [
      {
        id: "msg-1",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu-pending-1",
            name: "Task",
            input: {
              description: "Research data",
              subagent_type: "general-purpose",
            },
          },
        ],
      },
    ];
    apiMocks.getAgentMappings.mockResolvedValue({
      mappings: [
        {
          toolUseId: "toolu-pending-1",
          agentId: "agent-1",
        },
      ],
    });
    const agentContent = {
      messages: [{ id: "agent-msg-1", type: "assistant", content: "done" }],
      status: "completed",
    };
    apiMocks.getAgentSession.mockResolvedValue(agentContent);

    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(registerToolUseAgent).toHaveBeenCalledWith(
      "toolu-pending-1",
      "agent-1",
    );
    expect(mergeLoadedAgentContent).toHaveBeenCalledWith(
      "agent-1",
      agentContent,
    );
  });

  it("defers pending-agent backfill while the session DOM is parked", async () => {
    sessionMessagesMock.messages = [
      {
        id: "msg-parked",
        type: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu-parked",
            name: "Task",
            input: { description: "Background research" },
          },
        ],
      },
    ];

    const { rerender } = renderHook(
      ({ paused }) =>
        useSession(
          PROJECT_ID,
          "sess-1",
          { owner: "self", processId: "proc-1" },
          undefined,
          { backgroundEffectsPaused: paused },
        ),
      { initialProps: { paused: true } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.getAgentMappings).not.toHaveBeenCalled();

    rerender({ paused: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.getAgentMappings).toHaveBeenCalledTimes(1);
  });

  it("releases live session consumers while the session DOM is parked", () => {
    const { rerender } = renderHook(
      ({ paused }) =>
        useSession(
          PROJECT_ID,
          "sess-1",
          { owner: "self", processId: "proc-1" },
          undefined,
          { backgroundEffectsPaused: paused },
        ),
      { initialProps: { paused: false } },
    );

    expect(fileActivityOptions?.enabled).toBe(true);
    expect(sessionStreamSessionId).toBe("sess-1");

    rerender({ paused: true });

    expect(fileActivityOptions?.enabled).toBe(false);
    expect(sessionStreamSessionId).toBeNull();
    expect(sessionWatchTarget).toBeNull();

    rerender({ paused: false });

    expect(fileActivityOptions?.enabled).toBe(true);
    expect(sessionStreamSessionId).toBe("sess-1");
  });

  it("routes agent context usage through the action wrapper", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    const usage = { inputTokens: 2400, percentage: 48 };
    act(() => {
      streamingContentOptions?.onAgentContextUsage?.("agent-1", usage);
    });

    expect(updateAgentContextUsage).toHaveBeenCalledWith("agent-1", usage);
  });

  it("routes subagent placeholder cleanup through the action wrapper", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "assistant",
        id: "assistant-1",
        isSubagent: true,
        parentToolUseId: "toolu-subagent-1",
        content: "done",
      });
    });

    expect(clearAgentStreamingPlaceholders).toHaveBeenCalledWith(
      "toolu-subagent-1",
    );
  });

  it("routes current Claude child messages by provider agent ID", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "assistant",
        id: "assistant-current-child",
        isSubagent: true,
        agentId: "provider-child-1",
        content: "done",
      });
    });

    expect(clearAgentStreamingPlaceholders).toHaveBeenCalledWith(
      "provider-child-1",
    );
    expect(handleStreamSubagentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "assistant-current-child" }),
      "provider-child-1",
    );
    expect(registerToolUseAgent).not.toHaveBeenCalled();
  });

  it("routes main placeholder cleanup through the action wrapper", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "assistant",
        id: "assistant-1",
        content: "done",
      });
    });

    expect(clearStreamingPlaceholders).toHaveBeenCalledTimes(1);
    expect(clearAgentStreamingPlaceholders).not.toHaveBeenCalled();
  });

  it("routes session metadata events through the action wrapper", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      fileActivityOptions?.onSessionUpdated?.({
        type: "session-updated",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        title: "Renamed session",
        fullTitle: "Renamed session from Codex App",
        messageCount: 42,
        updatedAt: "2026-07-01T12:30:00.000Z",
        contextUsage: { inputTokens: 1200, percentage: 24 },
        model: "gpt-5.4",
        timestamp: "2026-07-01T12:30:00.000Z",
      });
    });

    expect(updateSession).toHaveBeenCalledTimes(1);
    const updater = updateSession.mock.calls[0]?.[0] as (
      previous: Record<string, unknown> | null,
    ) => Record<string, unknown> | null;
    expect(
      updater({
        id: "sess-1",
        provider: "codex",
        title: "Old title",
      }),
    ).toMatchObject({
      title: "Renamed session",
      fullTitle: "Renamed session from Codex App",
      messageCount: 42,
      updatedAt: "2026-07-01T12:30:00.000Z",
      contextUsage: { inputTokens: 1200, percentage: 24 },
      model: "gpt-5.4",
    });
  });

  it("syncs metadata process state when reconnect keeps ownership self", async () => {
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: {},
      ownership: {
        owner: "self",
        processId: "proc-1",
      },
      processState: "idle",
      pendingInputRequest: null,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(result.current.processState).toBe("in-turn");

    await act(async () => {
      await fileActivityOptions?.onReconnect?.();
    });

    expect(result.current.status).toMatchObject({
      owner: "self",
      processId: "proc-1",
    });
    expect(result.current.processState).toBe("idle");
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps idle activity newer than a phone-wake runtime snapshot", async () => {
    let resolveMetadata:
      | ((value: {
          session: Record<string, never>;
          ownership: { owner: "self"; processId: string };
          processState: "in-turn";
          pendingInputRequest: null;
        }) => void)
      | undefined;
    apiMocks.getSessionMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    let wakeReconciliation: void | Promise<void>;
    act(() => {
      wakeReconciliation = fileActivityOptions?.onReconnect?.();
    });

    act(() => {
      fileActivityOptions?.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        activity: "idle",
        timestamp: "2026-08-29T10:40:00.202Z",
      });
    });
    expect(result.current.processState).toBe("idle");

    await act(async () => {
      resolveMetadata?.({
        session: {},
        ownership: { owner: "self", processId: "proc-1" },
        processState: "in-turn",
        pendingInputRequest: null,
      });
      await wakeReconciliation;
    });

    expect(result.current.processState).toBe("idle");
  });

  it("does not apply a runtime snapshot to a different rendered session", async () => {
    let resolveMetadata:
      | ((value: {
          session: Record<string, never>;
          ownership: { owner: "self"; processId: string };
          processState: "in-turn";
          pendingInputRequest: null;
          deferredMessages: Array<{
            tempId: string;
            content: string;
            timestamp: string;
          }>;
        }) => void)
      | undefined;
    apiMocks.getSessionMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSession(PROJECT_ID, sessionId, undefined),
      { initialProps: { sessionId: "sess-a" } },
    );

    let wakeReconciliation: void | Promise<void>;
    act(() => {
      wakeReconciliation = fileActivityOptions?.onReconnect?.();
    });

    rerender({ sessionId: "sess-b" });

    await act(async () => {
      resolveMetadata?.({
        session: {},
        ownership: { owner: "self", processId: "proc-a" },
        processState: "in-turn",
        pendingInputRequest: null,
        deferredMessages: [
          {
            tempId: "sess-a-queued",
            content: "session A queue",
            timestamp: "2026-09-02T00:00:00.000Z",
          },
        ],
      });
      await wakeReconciliation;
    });

    expect(result.current.status).toEqual({ owner: "none" });
    expect(result.current.processState).toBe("idle");
    expect(result.current.deferredMessages).toEqual([]);
  });

  it("keeps authoritative idle over a pending-input fallback snapshot", async () => {
    let resolveMetadata:
      | ((value: {
          session: Record<string, never>;
          ownership: { owner: "self"; processId: string };
          processState: "waiting-input";
          pendingInputRequest: {
            id: string;
            sessionId: string;
            type: "tool-approval";
            prompt: string;
            timestamp: string;
          };
        }) => void)
      | undefined;
    apiMocks.getSessionMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      fileActivityOptions?.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        activity: "waiting-input",
        pendingInputType: "tool-approval",
        timestamp: "2026-08-29T10:40:00.202Z",
      });
    });
    act(() => {
      fileActivityOptions?.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        activity: "idle",
        timestamp: "2026-08-29T10:40:00.203Z",
      });
    });

    await act(async () => {
      resolveMetadata?.({
        session: {},
        ownership: { owner: "self", processId: "proc-1" },
        processState: "waiting-input",
        pendingInputRequest: {
          id: "request-1",
          sessionId: "sess-1",
          type: "tool-approval",
          prompt: "Allow the command?",
          timestamp: "2026-08-29T10:40:00.200Z",
        },
      });
      await Promise.resolve();
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.pendingInputRequest).toBeNull();
  });

  it("keeps newer live activity over an older failed stream check", async () => {
    let rejectMetadata: ((reason?: unknown) => void) | undefined;
    apiMocks.getSessionMetadata.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMetadata = reject;
        }),
    );
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    let streamRecovery: void | Promise<void>;
    act(() => {
      streamRecovery = sessionStreamErrorHandler?.();
    });

    act(() => {
      fileActivityOptions?.onProcessStateChange?.({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        activity: "in-turn",
        timestamp: "2026-08-29T10:40:01.000Z",
      });
    });

    await act(async () => {
      rejectMetadata?.(new Error("connection replaced"));
      await streamRecovery;
    });

    expect(result.current.status).toMatchObject({
      owner: "self",
      processId: "proc-1",
    });
    expect(result.current.processState).toBe("in-turn");
  });

  it("clears a failed read after transcript recovery", () => {
    const { result } = renderHook(() => useSession(PROJECT_ID, "sess-1"));
    act(() => sessionMessagesOptions?.onLoadError?.(new Error("offline")));
    expect(result.current.error?.message).toBe("offline");
    act(() =>
      sessionMessagesOptions?.onTranscriptReconciled?.("2026-10-04T14:00:00Z"),
    );
    expect(result.current.error).toBeNull();
  });

  it("reconciles a replayed busy navigation hint with retained idle state", async () => {
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: {},
      ownership: {
        owner: "self",
        processId: "proc-1",
      },
      processState: "idle",
      pendingInputRequest: null,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(result.current.processState).toBe("in-turn");

    await act(async () => {
      sessionMessagesOptions?.onLoadComplete?.({
        session: {
          id: "sess-1",
          projectId: PROJECT_ID,
          title: null,
          fullTitle: null,
          createdAt: "2026-04-23T23:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z",
          messageCount: 1,
          ownership: { owner: "self", processId: "proc-1" },
          provider: "codex",
        },
        status: { owner: "self", processId: "proc-1" },
      });
      await Promise.resolve();
    });

    expect(apiMocks.getSessionMetadata).toHaveBeenCalledWith(
      PROJECT_ID,
      "sess-1",
    );
    expect(result.current.processState).toBe("idle");
  });

  it("keeps a newer live snapshot over initial runtime reconciliation", async () => {
    let resolveMetadata:
      | ((value: {
          session: Record<string, never>;
          ownership: { owner: "self"; processId: string };
          processState: "idle";
          pendingInputRequest: null;
        }) => void)
      | undefined;
    apiMocks.getSessionMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionMessagesOptions?.onLoadComplete?.({
        session: {
          id: "sess-1",
          projectId: PROJECT_ID,
          title: null,
          fullTitle: null,
          createdAt: "2026-04-23T23:00:00.000Z",
          updatedAt: "2026-04-24T00:00:00.000Z",
          messageCount: 1,
          ownership: { owner: "self", processId: "proc-1" },
          provider: "codex",
        },
        status: { owner: "self", processId: "proc-1" },
      });
    });

    await act(async () => {
      sessionStreamHandler?.({
        eventType: "connected",
        sessionId: "sess-1",
        state: "in-turn",
        provider: "codex",
      });
      resolveMetadata?.({
        session: {},
        ownership: { owner: "self", processId: "proc-1" },
        processState: "idle",
        pendingInputRequest: null,
      });
      await Promise.resolve();
    });

    expect(result.current.processState).toBe("in-turn");
  });

  it("clears compacting state when reconnect reports no owner", async () => {
    apiMocks.getSessionMetadata.mockResolvedValue({
      session: {},
      ownership: { owner: "none" },
      processState: null,
      pendingInputRequest: null,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    await act(async () => {
      await fileActivityOptions?.onReconnect?.();
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("keeps compacting state when an old compact boundary was already loaded", () => {
    sessionMessagesMock.messages = [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "old-boundary",
        timestamp: "2026-04-23T00:00:00.000Z",
        content: "Context compacted",
      },
    ];

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);
  });

  it("clears compacting state when fetched messages add a compact boundary", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "status",
        status: "compacting",
      });
    });

    expect(result.current.isCompacting).toBe(true);

    sessionMessagesMock.messages = [
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "new-boundary",
        timestamp: "2026-04-23T00:01:00.000Z",
        content: "Context compacted",
      },
    ];

    act(() => {
      rerender();
    });

    expect(result.current.isCompacting).toBe(false);
  });

  it("mirrors the server deferred-queue event", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-a",
            content: "alpha message",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "beta message",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-a", content: "alpha message" },
      { tempId: "temp-b", content: "beta message" },
    ]);
  });

  it("fetches the durable row when a queued YA command completes", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        tempId: "ya-done-queued",
        yaCommand: "done",
        messages: [],
      });
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("replaces the deferred mirror wholesale on each server event", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-a",
            content: "alpha",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "beta",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
      settleStreamDispatch();
    });
    expect(result.current.deferredMessages).toHaveLength(2);

    // The server promotes temp-a and reports the remaining queue. The client
    // mirrors it wholesale — no merge, no fuzzy matching against the echo.
    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        reason: "promoted",
        tempId: "temp-a",
        messages: [
          {
            tempId: "temp-b",
            content: "beta",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-b", content: "beta" },
    ]);
  });

  it("clears every delivered deferred chip from a bundled user echo", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-a",
            content: "first queued message",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "second queued message",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
          {
            tempId: "temp-c",
            content: "unrelated queued message",
            timestamp: "2026-04-24T00:00:02.000Z",
          },
        ],
      });
      settleStreamDispatch();
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-echo",
        tempId: "temp-a",
        tempIds: ["temp-a", "temp-b"],
        message: {
          role: "user",
          content: "first queued message\n\n--------\n\nsecond queued message",
        },
      });
      settleStreamDispatch();
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-c", content: "unrelated queued message" },
    ]);

    // A slower queue snapshot must not resurrect rows whose delivery was
    // already proven by the user echo.
    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-a",
            content: "first queued message",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
          {
            tempId: "temp-b",
            content: "second queued message",
            timestamp: "2026-04-24T00:00:01.000Z",
          },
          {
            tempId: "temp-c",
            content: "unrelated queued message",
            timestamp: "2026-04-24T00:00:02.000Z",
          },
        ],
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-c", content: "unrelated queued message" },
    ]);
  });

  it("does not clear a deferred chip from matching echo text alone", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "deferred-queue",
        messages: [
          {
            tempId: "temp-a",
            content: "repeatable prompt",
            timestamp: "2026-04-24T00:00:00.000Z",
          },
        ],
      });
      sessionStreamHandler?.({
        eventType: "message",
        type: "user",
        uuid: "uuid-echo",
        message: { role: "user", content: "repeatable prompt" },
      });
    });

    expect(result.current.deferredMessages).toMatchObject([
      { tempId: "temp-a", content: "repeatable prompt" },
    ]);
  });

  it("settles a local command receipt without a provider user echo", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", { owner: "self", processId: "proc-1" }),
    );
    let tempId = "";
    act(() => {
      tempId = result.current.addPendingMessage("/goal ship it").tempId;
    });
    expect(result.current.pendingMessages).toHaveLength(1);
    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "system",
        subtype: "local_command",
        uuid: "goal-receipt",
        tempId,
        content: "/goal",
        details: ["ship it"],
      });
    });
    expect(result.current.pendingMessages).toEqual([]);
  });

  it("clears pending direct sends when persisted history contains the user turn", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "does origin have both parts",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });

    expect(result.current.pendingMessages).toHaveLength(1);

    sessionMessagesMock.messages = [
      {
        type: "user",
        uuid: "uuid-user",
        timestamp: "2026-05-23T04:36:39.966Z",
        message: {
          role: "user",
          content: "does origin have both parts",
        },
      },
      {
        type: "assistant",
        uuid: "uuid-assistant",
        timestamp: "2026-05-23T04:36:49.441Z",
        message: {
          role: "assistant",
          content: "No. The fetched origin/master has neither part.",
        },
      },
    ];

    // The send request can still be awaiting its response after a long reply.
    const pending = result.current.pendingMessages[0]!;
    const delivered = result.current.isMessageDelivered;
    sessionMessagesMock.messages.push(
      ...Array.from({ length: 80 }, (_, index) => ({
        type: "assistant",
        uuid: `reply-${index}`,
        content: "More tool activity",
      })),
    );

    rerender();

    expect(result.current.pendingMessages).toEqual([]);
    expect(delivered(pending)).toBe(true);
  });

  it("keeps pending direct sends when only older duplicate history matches", () => {
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "repeatable question",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });

    sessionMessagesMock.messages = [
      {
        type: "user",
        uuid: "uuid-old-user",
        timestamp: "2026-05-23T04:30:00.000Z",
        message: {
          role: "user",
          content: "repeatable question",
        },
      },
    ];

    rerender();

    expect(result.current.pendingMessages).toMatchObject([
      {
        content: "repeatable question",
      },
    ]);
  });

  const sessionFileChange: FileChangeEvent = {
    type: "file-change",
    provider: "codex",
    path: "/tmp/sess-1.jsonl",
    relativePath: "sess-1.jsonl",
    changeType: "modify",
    timestamp: "2026-05-23T04:36:40.000Z",
    mtimeMs: 1,
    size: 10,
    fileType: "session",
  };

  it("skips owned-session file-change fetches when no send is pending", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );
    fetchNewMessages.mockClear();

    act(() => {
      fileActivityOptions?.onFileChange?.(sessionFileChange);
    });

    expect(fetchNewMessages).not.toHaveBeenCalled();
  });

  it("fetches owned-session history while a Sending chip has no live echo", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "you misinterpreted a difference in labeling",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });
    fetchNewMessages.mockClear();

    act(() => {
      fileActivityOptions?.onFileChange?.(sessionFileChange);
    });

    expect(fetchNewMessages).toHaveBeenCalled();
  });

  it("reconciles a stuck Sending chip without waiting for a live echo", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      result.current.addPendingMessage(
        "you misinterpreted a difference in labeling",
        undefined,
        "2026-05-23T04:36:39.900Z",
      );
    });
    fetchNewMessages.mockClear();

    act(() => {
      vi.advanceTimersByTime(PENDING_SEND_RECONCILE_MS - 1);
    });
    expect(fetchNewMessages).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchNewMessages).toHaveBeenCalled();
  });

  it("captures session liveness snapshots from stream status events", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness(),
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "long-silent-unverified",
      activeWorkKind: "agent-turn",
    });
  });

  it("captures session liveness snapshots from stream heartbeats", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "heartbeat",
        liveness: mockLiveness({
          derivedStatus: "verified-progressing",
          lastVerifiedProgressAt: "2026-04-24T00:06:00.000Z",
          silenceMs: 0,
        }),
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "verified-progressing",
      lastVerifiedProgressAt: "2026-04-24T00:06:00.000Z",
    });
  });

  it("catches up when a heartbeat reports progress newer than durable state", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "heartbeat",
        liveness: mockLiveness({
          lastProviderMessageAt: "2026-04-24T00:06:00.000Z",
        }),
      });
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("retries the same heartbeat until transcript rows advance the watermark", () => {
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );
    const heartbeat = {
      eventType: "heartbeat",
      liveness: mockLiveness({
        lastProviderMessageAt: "2026-04-24T00:06:00.000Z",
      }),
    };

    act(() => sessionStreamHandler?.(heartbeat));
    expect(fetchNewMessages).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(500));
    act(() => sessionStreamHandler?.(heartbeat));
    expect(fetchNewMessages).toHaveBeenCalledTimes(2);
  });

  it("does not let activity metadata suppress transcript catch-up", () => {
    sessionMessagesMock.sessionUpdatedAt = "2026-04-24T00:06:00.000Z";

    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "heartbeat",
        liveness: mockLiveness({
          lastProviderMessageAt: "2026-04-24T00:06:00.000Z",
        }),
      });
    });

    expect(fetchNewMessages).toHaveBeenCalledTimes(1);
  });

  it("repairs a missed idle transition from the stream heartbeat", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    expect(result.current.processState).toBe("in-turn");

    const items: RenderItem[] = [
      { type: "user_prompt", id: "u1", content: "go", sourceMessages: [] },
      {
        type: "tool_call",
        id: "t1",
        toolName: "Bash",
        toolInput: { command: "npm test" },
        sourceMessages: [],
        status: "pending",
      },
    ];
    const activity = () =>
      getSessionActivityUiState({
        owner: result.current.status.owner,
        processState: result.current.processState,
        sessionLiveness: result.current.sessionLiveness,
        items,
      });
    expect(activity().showProcessingIndicator).toBe(true);

    act(() => {
      sessionStreamHandler?.({
        eventType: "heartbeat",
        liveness: mockLiveness({
          derivedStatus: "verified-idle",
          activeWorkKind: "none",
          state: "idle",
          lastVerifiedIdleAt: "2026-04-24T00:06:00.000Z",
        }),
      });
    });

    expect(result.current.processState).toBe("idle");
    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "verified-idle",
      state: "idle",
    });
    expect(activity().showProcessingIndicator).toBe(false);
    expect(activity().shouldDeferMessages).toBe(false);
    expect(activity().canStopOwnedProcess).toBe(false);
    expect(activity().shouldSuppressCurrentTurnOrphans).toBe(false);
  });

  it("moves stale liveness to live on user-visible stream progress", () => {
    const eventStart = new Date("2026-04-24T01:00:00.000Z");
    vi.setSystemTime(eventStart);
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness({
          checkedAt: "2026-04-24T00:00:00.000Z",
          lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
          silenceMs: 3_600_000,
          derivedStatus: "long-silent-unverified",
        }),
      });
      settleStreamDispatch();
    });

    expect(result.current.sessionLiveness?.derivedStatus).toBe(
      "long-silent-unverified",
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "verified-progressing",
      lastVerifiedProgressAt: new Date(
        eventStart.getTime() + DEFAULT_STREAM_DISPATCH_MIN_GAP_MS,
      ).toISOString(),
      evidence: expect.arrayContaining(["stream_event"]),
      lastRawProviderEventSource: "stream_event",
      silenceMs: 0,
    });
  });

  it("gates stream-progress liveness and publishes the trailing event", () => {
    const eventStart = new Date("2026-04-24T01:00:00.000Z");
    vi.setSystemTime(eventStart);
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );
    const sendVisibleDelta = () =>
      sessionStreamHandler?.({
        eventType: "message",
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x" },
        },
      });

    act(sendVisibleDelta);
    expect(result.current.sessionLiveness?.lastVerifiedProgressAt).toBe(
      eventStart.toISOString(),
    );

    act(() => {
      vi.advanceTimersByTime(499);
      sendVisibleDelta();
    });
    expect(result.current.sessionLiveness?.lastVerifiedProgressAt).toBe(
      eventStart.toISOString(),
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.sessionLiveness?.lastVerifiedProgressAt).toBe(
      new Date(eventStart.getTime() + 499).toISOString(),
    );

    act(() => {
      settleStreamDispatch();
      sendVisibleDelta();
      vi.advanceTimersByTime(500);
    });
    expect(result.current.sessionLiveness?.lastVerifiedProgressAt).toBe(
      new Date(
        eventStart.getTime() + 500 + DEFAULT_STREAM_DISPATCH_MIN_GAP_MS,
      ).toISOString(),
    );
  });

  it("keeps stale liveness when stream_event has no user-visible content", () => {
    const eventStart = new Date("2026-04-24T01:00:00.000Z");
    vi.setSystemTime(eventStart);
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "status",
        state: "in-turn",
        liveness: mockLiveness({
          checkedAt: "2026-04-24T00:00:00.000Z",
          lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
          silenceMs: 3_600_000,
          derivedStatus: "long-silent-unverified",
        }),
      });
    });

    expect(result.current.sessionLiveness?.derivedStatus).toBe(
      "long-silent-unverified",
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "message",
        type: "stream_event",
      });
    });

    expect(result.current.sessionLiveness).toMatchObject({
      derivedStatus: "long-silent-unverified",
      lastVerifiedProgressAt: "2026-04-24T00:00:00.000Z",
      silenceMs: 3_600_000,
    });
  });

  it("drops live markdown events when response streaming is disabled", () => {
    window.localStorage.setItem(UI_KEYS.streamingEnabled, "false");
    const streamingMarkdownCallbacks = {
      onAugment: vi.fn(),
      onPending: vi.fn(),
      onStreamEnd: vi.fn(),
      setCurrentMessageId: vi.fn(),
      captureHtml: vi.fn(() => null),
    };
    const { result } = renderHook(() =>
      useSession(
        PROJECT_ID,
        "sess-1",
        {
          owner: "self",
          processId: "proc-1",
        },
        streamingMarkdownCallbacks,
      ),
    );

    act(() => {
      sessionStreamHandler?.({
        eventType: "markdown-augment",
        blockIndex: 0,
        html: "<p>partial</p>",
        type: "text",
      });
      sessionStreamHandler?.({
        eventType: "pending",
        html: "<p>pending</p>",
      });
      sessionStreamHandler?.({
        eventType: "markdown-augment",
        messageId: "assistant-1",
        html: "<p>complete</p>",
      });
      settleStreamDispatch();
    });

    expect(streamingMarkdownCallbacks.onAugment).not.toHaveBeenCalled();
    expect(streamingMarkdownCallbacks.onPending).not.toHaveBeenCalled();
    expect(applyFinalMarkdownAugment).toHaveBeenCalledWith(
      "assistant-1",
      "<p>complete</p>",
    );
    expect(result.current.markdownAugments).toEqual({});
  });

  it("does not load permission mode from localStorage on session view mount", () => {
    window.localStorage.setItem(
      "yep-anywhere-permission-mode",
      "bypassPermissions",
    );

    const { result } = renderHook(() => useSession(PROJECT_ID, "sess-1"));

    expect(result.current.permissionMode).toBe("default");
    expect(apiMocks.setPermissionMode).not.toHaveBeenCalled();
  });

  it("treats backend default mode as authoritative instead of reapplying localStorage", async () => {
    window.localStorage.setItem(
      "yep-anywhere-permission-mode",
      "bypassPermissions",
    );

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    await act(async () => {
      sessionStreamHandler?.({
        eventType: "connected",
        sessionId: "sess-1",
        state: "idle",
        permissionMode: "default",
        modeVersion: 0,
        provider: "codex",
      });
    });

    expect(result.current.permissionMode).toBe("default");
    expect(apiMocks.setPermissionMode).not.toHaveBeenCalled();
  });

  it("uses explicit initial owned permission mode for newly started sessions", () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "bypassPermissions",
        modeVersion: 2,
      }),
    );

    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.modeVersion).toBe(2);
  });

  it("keeps a Codex mode pending until the server reports it applied", async () => {
    apiMocks.setPermissionMode.mockResolvedValueOnce({
      permissionMode: "bypassPermissions",
      appliedPermissionMode: "default",
      modeVersion: 3,
    });
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "default",
        appliedPermissionMode: "default",
        modeVersion: 2,
      }),
    );

    await act(async () => {
      await result.current.setPermissionMode("bypassPermissions");
    });

    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.status).toMatchObject({
      owner: "self",
      appliedPermissionMode: "default",
    });

    act(() => {
      sessionStreamHandler?.({
        eventType: "mode-applied",
        appliedPermissionMode: "bypassPermissions",
      });
    });

    expect(result.current.status).toMatchObject({
      owner: "self",
      appliedPermissionMode: "bypassPermissions",
    });
  });

  it("keeps the same-page toolbar mode after ownership drops", async () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
      }),
    );

    await act(async () => {
      await result.current.setPermissionMode("acceptEdits");
    });

    expect(result.current.permissionMode).toBe("acceptEdits");
    expect(
      window.localStorage.getItem("yep-anywhere-permission-mode"),
    ).toBeNull();

    act(() => {
      fileActivityOptions?.onSessionStatusChange?.({
        type: "session-status-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID,
        ownership: { owner: "none" } as SessionStatus,
        timestamp: "2026-04-23T00:00:00.000Z",
      });
    });

    expect(result.current.status).toEqual({ owner: "none" });
    expect(result.current.permissionMode).toBe("acceptEdits");
  });

  it("uses the configured away threshold for recap requests", () => {
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() =>
        useSession(PROJECT_ID, "sess-1", {
          owner: "self",
          processId: "proc-1",
          recapAfterSeconds: 2,
          recapMode: "fork",
        }),
      );

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(1_999);
        visibility.set("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(apiMocks.requestSessionRecap).not.toHaveBeenCalled();

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
        visibility.set("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(apiMocks.requestSessionRecap).toHaveBeenCalledTimes(1);
      expect(apiMocks.requestSessionRecap).toHaveBeenCalledWith(
        PROJECT_ID,
        "sess-1",
        Date.parse("2026-04-24T00:00:01.999Z"),
      );
    } finally {
      visibility.restore();
    }
  });

  it("fires a background recap after the away threshold while still hidden", () => {
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() =>
        useSession(PROJECT_ID, "sess-bg", {
          owner: "self",
          processId: "proc-bg",
          recapAfterSeconds: 2,
          recapMode: "fork",
        }),
      );

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // No return: the recap must fire in the background once the threshold passes.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(apiMocks.requestSessionRecap).toHaveBeenCalledTimes(1);
      expect(apiMocks.requestSessionRecap).toHaveBeenCalledWith(
        PROJECT_ID,
        "sess-bg",
        Date.parse("2026-04-24T00:00:00.000Z"),
      );
    } finally {
      visibility.restore();
    }
  });

  it("fires a background recap after navigating away from a live session", () => {
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const visibility = installVisibilityStateMock("visible");

    try {
      const { unmount } = renderHook(() =>
        useSession(PROJECT_ID, "sess-nav", {
          owner: "self",
          processId: "proc-nav",
          recapAfterSeconds: 2,
          recapMode: "fork",
        }),
      );

      act(() => {
        unmount();
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(apiMocks.requestSessionRecap).toHaveBeenCalledTimes(1);
      expect(apiMocks.requestSessionRecap).toHaveBeenCalledWith(
        PROJECT_ID,
        "sess-nav",
        Date.parse("2026-04-24T00:00:00.000Z"),
      );
    } finally {
      visibility.restore();
    }
  });

  it("cancels the background recap when returning before the threshold", () => {
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() =>
        useSession(PROJECT_ID, "sess-cancel", {
          owner: "self",
          processId: "proc-cancel",
          recapAfterSeconds: 5,
          recapMode: "fork",
        }),
      );

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
        visibility.set("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(apiMocks.requestSessionRecap).not.toHaveBeenCalled();
    } finally {
      visibility.restore();
    }
  });

  it("does not POST when recap mode is unknown (never live this view)", () => {
    // A list-browsed session whose mode we never learned must not fire: the
    // POST would only be skipped server-side. Recaps must be confirmed enabled.
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() => useSession(PROJECT_ID, "sess-noproc"));

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(600_000);
      });

      expect(apiMocks.requestSessionRecap).not.toHaveBeenCalled();
    } finally {
      visibility.restore();
    }
  });

  it("does not POST when recaps are off for a live session", () => {
    const visibility = installVisibilityStateMock("visible");

    try {
      renderHook(() =>
        useSession(PROJECT_ID, "sess-off", {
          owner: "self",
          processId: "proc-off",
          recapAfterSeconds: 2,
          recapMode: "off",
        }),
      );

      act(() => {
        visibility.set("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => {
        vi.advanceTimersByTime(600_000);
      });

      expect(apiMocks.requestSessionRecap).not.toHaveBeenCalled();
    } finally {
      visibility.restore();
    }
  });
});

describe("useSession permission mode persistence", () => {
  beforeEach(() => {
    sessionMessagesMock.effectiveLaunchSettings = undefined;
    vi.clearAllMocks();
    apiMocks.getSessionMetadata.mockReset();
    apiMocks.setPermissionMode.mockReset();
    apiMocks.setPermissionMode.mockResolvedValue({
      permissionMode: "bypassPermissions",
      modeVersion: 1,
    });
    installLocalStorageMock();
    fileActivityOptions = undefined;
    sessionStreamHandler = null;
    sessionMessagesMock.messages = [];
    sessionMessagesMock.provider = "codex";
  });

  it("adopts saved Bypass on a fresh browser and keeps it while the resumed stream connects", async () => {
    sessionMessagesMock.effectiveLaunchSettings = {
      schemaVersion: 1,
      revision: 2,
      permissionMode: "bypassPermissions",
      requestedModel: "gpt-5.4",
      serviceTier: null,
      thinking: null,
      effort: null,
    };
    const { result } = renderHook(() => useSession(PROJECT_ID, "sess-1"));
    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.permissionModeOverride).toBeUndefined();
    act(() =>
      result.current.setStatus({ owner: "self", processId: "new-process" }),
    );
    expect(result.current.permissionMode).toBe("bypassPermissions");
  });

  it("preserves an explicit stopped Ask selection across saved-settings refreshes", async () => {
    sessionMessagesMock.effectiveLaunchSettings = {
      schemaVersion: 1,
      revision: 2,
      permissionMode: "bypassPermissions",
      requestedModel: "gpt-5.4",
      serviceTier: null,
      thinking: null,
      effort: null,
    };
    const { result, rerender } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1"),
    );
    await act(async () => result.current.setPermissionMode("default"));
    sessionMessagesMock.effectiveLaunchSettings = {
      ...sessionMessagesMock.effectiveLaunchSettings,
      revision: 3,
      permissionMode: "plan",
    };
    rerender();
    expect(result.current.permissionMode).toBe("default");
    expect(result.current.permissionModeOverride).toBe("default");
  });

  it("restores the stored mode when no live process reports one", () => {
    window.localStorage.setItem("permission-mode-sess-1", "bypassPermissions");

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", undefined),
    );

    expect(result.current.permissionMode).toBe("bypassPermissions");
  });

  it("prefers a live process mode over the stored mode", () => {
    window.localStorage.setItem("permission-mode-sess-1", "bypassPermissions");

    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "plan",
      }),
    );

    expect(result.current.permissionMode).toBe("plan");
  });

  it("does not treat browser defaults or stored modes as explicit overrides", () => {
    window.localStorage.setItem("permission-mode-sess-1", "default");
    const { result, rerender } = renderHook(
      ({ id }) => useSession(PROJECT_ID, id),
      { initialProps: { id: "sess-1" } },
    );
    expect(result.current.permissionModeOverride).toBeUndefined();
    rerender({ id: "fresh-session" });
    expect(result.current.permissionModeOverride).toBeUndefined();
  });

  it("retains an explicit Ask selection only for its stopped session", async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSession(PROJECT_ID, id),
      { initialProps: { id: "sess-1" } },
    );
    await act(async () => result.current.setPermissionMode("default"));
    expect(result.current.permissionModeOverride).toBe("default");
    expect(apiMocks.setPermissionMode).not.toHaveBeenCalled();
    rerender({ id: "sess-2" });
    expect(result.current.permissionModeOverride).toBeUndefined();
  });

  it("retires an override once the live provider confirms it", async () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", {
        owner: "self",
        processId: "proc-1",
        permissionMode: "default",
      }),
    );
    await act(async () =>
      result.current.setPermissionMode("bypassPermissions"),
    );
    expect(result.current.permissionMode).toBe("bypassPermissions");
    expect(result.current.permissionModeOverride).toBeUndefined();
  });

  it("persists the selected mode to storage", async () => {
    const { result } = renderHook(() =>
      useSession(PROJECT_ID, "sess-1", undefined),
    );

    await act(async () => {
      await result.current.setPermissionMode("bypassPermissions");
    });

    expect(window.localStorage.getItem("permission-mode-sess-1")).toBe(
      "bypassPermissions",
    );
  });

  it("restores the stored per-session model when reopening an idle session", () => {
    // A model picked earlier in this session and abandoned before the next turn
    // only lives in localStorage (see sessionPickStorage). The mocked session
    // reports "gpt-5.4", so a restore to "opus" proves the pick was reapplied.
    sessionModelPick.save("sess-1", "opus");
    // No initialStatus → the hook defaults to an idle { owner: "none" } session.
    renderHook(() => useSession(PROJECT_ID, "sess-1", undefined));

    const restoredModels = updateSession.mock.calls
      .map(([update]) =>
        typeof update === "function"
          ? update({ id: "sess-1", model: "gpt-5.4" })
          : update,
      )
      .map((next) => next?.model);
    expect(restoredModels).toContain("opus");
  });

  it("does not override a live self-owned process's model on load", () => {
    // A running process's model is authoritative; the stored pick must not clobber
    // it on reopen — it only overlays when the session is idle.
    sessionModelPick.save("sess-1", "opus");
    renderHook(() =>
      useSession(PROJECT_ID, "sess-1", { owner: "self", processId: "proc-1" }),
    );

    const restoredModels = updateSession.mock.calls
      .map(([update]) =>
        typeof update === "function"
          ? update({ id: "sess-1", model: "gpt-5.4" })
          : update,
      )
      .map((next) => next?.model);
    expect(restoredModels).not.toContain("opus");
  });
});
