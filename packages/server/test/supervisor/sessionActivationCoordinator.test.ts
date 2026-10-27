import { describe, expect, it } from "vitest";
import type { Process } from "../../src/supervisor/Process.js";
import {
  SessionActivationCoordinator,
  type SessionActivationCoordinatorOptions,
} from "../../src/supervisor/SessionActivationCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function coordinator(
  overrides: Partial<SessionActivationCoordinatorOptions> = {},
): SessionActivationCoordinator {
  return new SessionActivationCoordinator({
    defaultPermissionMode: "default",
    getProcess: () => undefined,
    getProcessForSession: () => undefined,
    unregisterProcess: () => {},
    assertProviderOwnershipSettled: () => {},
    assertSessionSandboxSettings: () => {},
    restartProcess: async () => null,
    ...overrides,
  });
}

describe("SessionActivationCoordinator", () => {
  it("snapshots after queued changes and uses applied effort rather than an unsent selection", async () => {
    const gate = deferred<void>();
    const process = {
      id: "process-1",
      sessionId: "source",
      isTerminated: false,
      permissionMode: "bypassPermissions",
      requestedModel: "default",
      resolvedModel: "resolved-source",
      model: "default",
      thinking: { type: "adaptive" },
      appliedEffort: "high",
      effort: "max",
      serviceTier: "priority",
    } as unknown as Process;
    const state = coordinator({ getProcessForSession: () => process });
    const change = state.enqueueConfiguration("source", async () => {
      await gate.promise;
      Object.assign(process, {
        permissionMode: "default",
        appliedEffort: "low",
      });
    });
    const snapshot = state.snapshotLaunchSettings(
      "project" as never,
      "source",
      "claude",
    );
    gate.resolve();
    await change;
    expect(await snapshot).toEqual({
      permissionMode: "default",
      requestedModel: "resolved-source",
      thinking: { type: "adaptive" },
      effort: "low",
      serviceTier: "priority",
    });
  });

  it("exposes one settled activation result to concurrent waiters", async () => {
    const activationGate = deferred<Process>();
    const state = coordinator();

    const activation = state.startActivation(
      "session-1",
      () => activationGate.promise,
    );
    const waiter = state.waitForActivation("session-1");
    let waiterSettled = false;
    void waiter.finally(() => {
      waiterSettled = true;
    });

    await Promise.resolve();
    expect(waiterSettled).toBe(false);

    const process = { id: "process-1" } as Process;
    activationGate.resolve(process);
    await expect(activation).resolves.toBe(process);
    await expect(waiter).resolves.toBe(true);
    await expect(state.waitForActivation("session-1")).resolves.toBe(false);
  });

  it("prefers completed transcript settings when requested for resume recovery", async () => {
    const state = coordinator({
      sessionMetadataService: {
        getEffectiveLaunchSettings: () => ({
          permissionMode: "default",
          requestedModel: "durable-model",
          thinking: { type: "disabled" },
        }),
        getRequestedModel: () => "legacy-model",
      } as unknown as NonNullable<
        SessionActivationCoordinatorOptions["sessionMetadataService"]
      >,
      recoverSessionLaunchSettings: async () => ({
        permissionMode: "bypassPermissions",
        requestedModel: "transcript-model",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      }),
    });

    await expect(
      state.resolveColdLaunchSettings(
        "project" as never,
        "session-1",
        undefined,
        {
          requestedModel: "stale-model",
          recoverTranscriptLaunchSettings: true,
        },
      ),
    ).resolves.toMatchObject({
      permissionMode: "bypassPermissions",
      modelSettings: {
        requestedModel: "transcript-model",
        model: "transcript-model",
        serviceTier: "priority",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });

  it("flushes the latest standing policy before reload and propagates write failures", async () => {
    const gate = deferred<void>();
    const writes: string[] = [];
    let fail = false;
    const state = coordinator({
      sessionMetadataService: {
        recordEffectiveLaunchSettings: async (
          _id: string,
          value: { permissionMode: string },
        ) => {
          writes.push(value.permissionMode);
          if (fail) throw new Error("disk unavailable");
        },
        flushPendingWrites: async () => {
          writes.push("flushed");
        },
      } as unknown as NonNullable<
        SessionActivationCoordinatorOptions["sessionMetadataService"]
      >,
    });
    const process = {
      id: "process-1",
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
    } as Process;
    const pending = state.enqueueConfiguration("session-1", async () => {
      await gate.promise;
      Object.assign(process, { permissionMode: "default" });
    });
    const reload = state.prepareForServerReload(process);
    expect(writes).toEqual([]);
    gate.resolve();
    await pending;
    await reload;
    expect(writes).toEqual(["default", "flushed"]);
    fail = true;
    await expect(state.prepareForServerReload(process)).rejects.toThrow(
      "disk unavailable",
    );
    expect(writes).toEqual(["default", "flushed", "default"]);
  });

  describe("stopping process launch settings", () => {
    function stoppingFixture() {
      const gate = deferred<void>();
      const writes: string[] = [];
      let owner: Process | undefined;
      const state = coordinator({
        getProcessForSession: () => owner,
        sessionMetadataService: {
          recordEffectiveLaunchSettings: async (
            _id: string,
            value: { permissionMode: string },
          ) => {
            writes.push(value.permissionMode);
          },
        } as unknown as NonNullable<
          SessionActivationCoordinatorOptions["sessionMetadataService"]
        >,
      });
      const process = {
        id: "process-1",
        sessionId: "session-1",
        permissionMode: "default",
        isTerminated: false,
      } as Process;
      owner = process;
      // A configuration transition still running holds the scheduled save.
      const busy = state.enqueueConfiguration("session-1", () => gate.promise);
      Object.assign(process, { permissionMode: "plan" });
      state.scheduleLaunchSettingsPersistence(process, "permissionMode");
      const stop = (successor?: Process) => {
        Object.assign(process, { isTerminated: true });
        owner = successor;
        state.discardProcess(process);
      };
      return { state, process, writes, gate, busy, stop };
    }

    it("saves a mode change whose scheduled save the stop overtook", async () => {
      const { state, process, writes, gate, busy, stop } = stoppingFixture();

      const settled = state.settleStoppingProcessLaunchSettings(process);
      expect(state.settleStoppingProcessLaunchSettings(process)).toBe(settled);
      stop();
      gate.resolve();
      await busy;
      await settled;

      expect(writes).toEqual(["plan"]);
    });

    it("leaves the session to a successor that owns it by then", async () => {
      const { state, process, writes, gate, busy, stop } = stoppingFixture();

      const settled = state.settleStoppingProcessLaunchSettings(process);
      stop({ id: "process-2", sessionId: "session-1" } as Process);
      gate.resolve();
      await busy;
      await settled;

      expect(writes).toEqual([]);
    });
  });

  it("runs configuration transitions in request order", async () => {
    const firstGate = deferred<void>();
    const state = coordinator();
    const transitions: string[] = [];

    const first = state.enqueueConfiguration("session-1", async () => {
      transitions.push("first-start");
      await firstGate.promise;
      transitions.push("first-end");
      return 1;
    });
    const second = state.enqueueConfiguration("session-1", async () => {
      transitions.push("second");
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(transitions).toEqual(["first-start"]);

    firstGate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(transitions).toEqual(["first-start", "first-end", "second"]);
  });
});
