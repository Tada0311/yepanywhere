import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus, type BusEvent } from "../../src/watcher/EventBus.js";

describe("ExternalSessionTracker", () => {
  it("resolves retained activity counts without foreground project discovery", async () => {
    const eventBus = new EventBus();
    const projectId = encodeProjectId("/tmp/test");
    const complete = vi.fn().mockResolvedValue({ id: projectId });
    const retained = vi.fn().mockReturnValue({ id: projectId });
    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor: {
        getProcessForSession: () => undefined,
      } as unknown as Supervisor,
      scanner: {
        getProjectBySessionDirSuffix: complete,
        getRetainedProjectBySessionDirSuffix: retained,
      } as unknown as ProjectScanner,
    });
    try {
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/external.jsonl",
        relativePath: "-tmp-test/external.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });
      await vi.waitFor(() => expect(tracker.isExternal("external")).toBe(true));
      const calls = complete.mock.calls.length;
      expect(
        await tracker.getExternalSessionInfoWithUrlId("external", {
          retained: true,
        }),
      ).toMatchObject({ projectId });
      expect(retained).toHaveBeenCalledExactlyOnceWith("-tmp-test");
      expect(complete).toHaveBeenCalledTimes(calls);
    } finally {
      tracker.dispose();
    }
  });

  it("does not mark owned active Claude sessions external on file changes", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      getProcessForSession: vi.fn((sessionId: string) =>
        sessionId === "owned-active-session"
          ? { projectId, state: { type: "in-turn" } }
          : undefined,
      ),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
    });

    try {
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/owned-active-session.jsonl",
        relativePath: "-tmp-test/owned-active-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("owned-active-session")).toBe(false);
      expect(scanner.getProjectBySessionDirSuffix).not.toHaveBeenCalled();
      expect(
        events.some(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === "owned-active-session" &&
            event.ownership.owner === "external",
        ),
      ).toBe(false);
    } finally {
      tracker.dispose();
    }
  });

  it("does not mark recently aborted Claude sessions external on file changes", async () => {
    const eventBus = new EventBus();
    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      abortGraceMs: 1000,
    });

    try {
      eventBus.emit({
        type: "session-aborted",
        sessionId: "idle-reaped-session",
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/idle-reaped-session.jsonl",
        relativePath: "-tmp-test/idle-reaped-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("idle-reaped-session")).toBe(false);
      expect(scanner.getProjectBySessionDirSuffix).not.toHaveBeenCalled();
    } finally {
      tracker.dispose();
    }
  });

  it("does not call a session we just forked externally active", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      // A cold fork has no process yet, which is exactly the case that used to
      // read as an external writer.
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      forkGraceMs: 1000,
    });

    try {
      eventBus.emit({
        type: "session-forked",
        sessionId: "fresh-fork-session",
        sourceSessionId: "source-session",
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/fresh-fork-session.jsonl",
        relativePath: "-tmp-test/fresh-fork-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("fresh-fork-session")).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === "fresh-fork-session" &&
            event.ownership.owner === "external",
        ),
      ).toBe(false);
    } finally {
      tracker.dispose();
    }
  });

  it("marks a forked session external once the fork grace has passed", async () => {
    const eventBus = new EventBus();
    const projectId = encodeProjectId("/tmp/test");
    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      // Expired before the file change arrives: a later writer is external
      // again, exactly as for a session we never forked.
      forkGraceMs: 0,
    });

    try {
      eventBus.emit({
        type: "session-forked",
        sessionId: "stale-fork-session",
        sourceSessionId: "source-session",
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/tmp/projects/-tmp-test/stale-fork-session.jsonl",
        relativePath: "-tmp-test/stale-fork-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await Promise.resolve();

      expect(tracker.isExternal("stale-fork-session")).toBe(true);
    } finally {
      tracker.dispose();
    }
  });

  it("reports a Pi session we just forked as unowned, not external", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectPath = "/tmp/pi-fork-project";
    const projectId = encodeProjectId(projectPath);
    const sessionId = "pi-fresh-fork-session";
    const tempDir = join(tmpdir(), `pi-fork-${randomUUID()}`);
    const sessionFile = join(tempDir, "2026-09-27_pi-fresh-fork-session.jsonl");

    await mkdir(tempDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: projectPath,
        timestamp: "2026-09-27T00:00:00.000Z",
      })}\n`,
    );

    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      forkGraceMs: 1000,
    });

    try {
      eventBus.emit({
        type: "session-forked",
        sessionId,
        sourceSessionId: "pi-source-session",
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "pi",
        path: sessionFile,
        relativePath: "encoded/2026-09-27_pi-fresh-fork-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "session-created" &&
              event.session.id === sessionId,
          ),
        ).toBe(true);
      });

      const creation = events.find(
        (event) =>
          event.type === "session-created" && event.session.id === sessionId,
      );
      expect(creation).toMatchObject({
        session: { provider: "pi", ownership: { owner: "none" } },
      });
      expect(tracker.isExternal(sessionId)).toBe(false);
    } finally {
      tracker.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores a recently aborted Codex session's cleanup writes", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectPath = "/tmp/codex-aborted-project";
    const projectId = encodeProjectId(projectPath);
    const sessionId = "019f28d9-2dff-7dd2-8326-4b0e6093aed6";
    const tempDir = join(tmpdir(), `codex-aborted-${randomUUID()}`);
    const sessionFile = join(tempDir, `rollout-${sessionId}.jsonl`);
    // Positive control: an unaborted rollout written alongside it.
    const controlId = "019f28d9-2dff-7dd2-8326-4b0e6093aed7";
    const controlFile = join(tempDir, `rollout-${controlId}.jsonl`);

    await mkdir(tempDir, { recursive: true });
    for (const file of [sessionFile, controlFile]) {
      await writeFile(
        file,
        `${JSON.stringify({
          type: "session_meta",
          payload: { cwd: projectPath, timestamp: "2026-09-27T00:00:00.000Z" },
        })}\n`,
      );
    }

    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      abortGraceMs: 1000,
    });

    try {
      eventBus.emit({
        type: "session-aborted",
        sessionId,
        projectId,
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: sessionFile,
        relativePath: `2026/09/27/rollout-${sessionId}.jsonl`,
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: controlFile,
        relativePath: `2026/09/27/rollout-${controlId}.jsonl`,
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      // The same header read settles the control, which is not aborted.
      await vi.waitFor(() => {
        expect(tracker.isExternal(controlId)).toBe(true);
      });

      expect(tracker.isExternal(sessionId)).toBe(false);
      expect(
        events.some(
          (event) =>
            (event.type === "session-created" &&
              event.session.id === sessionId) ||
            (event.type === "session-status-changed" &&
              event.sessionId === sessionId),
        ),
      ).toBe(false);
    } finally {
      tracker.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits only bounded fields for owned Codex file changes", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const projectId = encodeProjectId("/tmp/codex-project");
    const sessionId = "019f28d9-2dff-7dd2-8326-4b0e6093aed4";
    const supervisor = {
      getProcessForSession: vi.fn((candidate: string) =>
        candidate === sessionId
          ? { projectId, state: { type: "in-turn" } }
          : undefined,
      ),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;
    const getSessionSummary = vi.fn(async () => ({
      id: sessionId,
      projectId,
      title: "Codex title",
      fullTitle: "Codex title",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:01.000Z",
      messageCount: 1,
      ownership: { owner: "none" as const },
      provider: "codex" as const,
    }));
    const getSessionListSummary = vi.fn(async () => ({
      id: sessionId,
      projectId,
      title: "Codex title",
      fullTitle: "Codex title",
      updatedAt: "2026-07-04T00:00:01.000Z",
      provider: "codex" as const,
    }));

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
      getSessionSummary,
      getSessionListSummary,
    });

    try {
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: `/tmp/codex/rollout-${sessionId}.jsonl`,
        relativePath: `2026/07/04/rollout-${sessionId}.jsonl`,
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(getSessionListSummary).toHaveBeenCalledWith(
          sessionId,
          projectId,
        );
      });
      expect(getSessionSummary).not.toHaveBeenCalled();
      const update = events.find(
        (event) =>
          event.type === "session-updated" && event.sessionId === sessionId,
      );
      expect(update).toMatchObject({
        type: "session-updated",
        sessionId,
        projectId,
        title: "Codex title",
        fullTitle: "Codex title",
        updatedAt: "2026-07-04T00:00:01.000Z",
      });
      expect(update).not.toHaveProperty("messageCount");
      expect(update).not.toHaveProperty("contextUsage");
      expect(update).not.toHaveProperty("model");
      expect(update).not.toHaveProperty("lastAgentText");
      expect(tracker.isExternal(sessionId)).toBe(false);
    } finally {
      tracker.dispose();
    }
  });

  it("keeps external Codex creation complete before bounded updates", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectPath = "/tmp/external-codex-project";
    const projectId = encodeProjectId(projectPath);
    const sessionId = "019f28d9-2dff-7dd2-8326-4b0e6093aed5";
    const tempDir = join(tmpdir(), `codex-external-${randomUUID()}`);
    const sessionFile = join(tempDir, `rollout-${sessionId}.jsonl`);

    await mkdir(tempDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: projectPath,
          timestamp: "2026-07-04T00:00:00.000Z",
          model: "codex-test-model",
        },
      })}\n`,
    );

    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;
    const getSessionSummary = vi.fn(async () => null);
    const getSessionListSummary = vi.fn(async () => ({
      id: sessionId,
      projectId,
      title: "External Codex title",
      fullTitle: "External Codex title",
      updatedAt: "2026-07-04T00:00:01.000Z",
      provider: "codex" as const,
    }));

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 1000,
      getSessionSummary,
      getSessionListSummary,
    });

    try {
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: sessionFile,
        relativePath: `2026/07/04/rollout-${sessionId}.jsonl`,
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(getSessionListSummary).toHaveBeenCalledWith(
          sessionId,
          projectId,
        );
      });

      const creation = events.find(
        (event) =>
          event.type === "session-created" && event.session.id === sessionId,
      );
      expect(creation).toMatchObject({
        type: "session-created",
        session: {
          id: sessionId,
          projectId,
          messageCount: 0,
          model: "codex-test-model",
          ownership: { owner: "external" },
        },
      });

      const update = events.find(
        (event) =>
          event.type === "session-updated" && event.sessionId === sessionId,
      );
      expect(update).toMatchObject({
        type: "session-updated",
        sessionId,
        projectId,
        title: "External Codex title",
        fullTitle: "External Codex title",
        updatedAt: "2026-07-04T00:00:01.000Z",
      });
      expect(update).not.toHaveProperty("messageCount");
      expect(update).not.toHaveProperty("contextUsage");
      expect(update).not.toHaveProperty("model");
      expect(update).not.toHaveProperty("lastAgentText");
      expect(getSessionSummary).not.toHaveBeenCalled();
    } finally {
      tracker.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks Pi sessions external from the JSONL header", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));

    const projectPath = "/tmp/pi-project";
    const projectId = encodeProjectId(projectPath);
    const sessionId = "pi-external-session";
    const tempDir = join(tmpdir(), `pi-external-${randomUUID()}`);
    const sessionFile = join(tempDir, "2026-06-23_pi-external-session.jsonl");

    await mkdir(tempDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: projectPath,
        timestamp: "2026-06-23T00:00:00.000Z",
      })}\n`,
    );

    const supervisor = {
      getProcessForSession: vi.fn(() => undefined),
    } as unknown as Supervisor;
    const scanner = {
      getProjectBySessionDirSuffix: vi.fn(),
    } as unknown as ProjectScanner;

    const tracker = new ExternalSessionTracker({
      eventBus,
      supervisor,
      scanner,
      decayMs: 100,
    });

    try {
      eventBus.emit({
        type: "file-change",
        provider: "pi",
        path: sessionFile,
        relativePath: "encoded/2026-06-23_pi-external-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => {
        expect(tracker.isExternal(sessionId)).toBe(true);
      });

      expect(scanner.getProjectBySessionDirSuffix).not.toHaveBeenCalled();
      expect(
        events.some(
          (event) =>
            event.type === "session-status-changed" &&
            event.sessionId === sessionId &&
            event.projectId === projectId &&
            event.ownership.owner === "external",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "session-created" &&
            event.session.id === sessionId &&
            event.session.provider === "pi" &&
            event.session.ownership.owner === "external",
        ),
      ).toBe(true);
    } finally {
      tracker.dispose();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
