import type { UrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
  SUPERUSER,
} from "../../src/auth/principal.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { RecentsService } from "../../src/recents/index.js";
import type { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { createRecentsRoutes } from "../../src/routes/recents.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex recent session",
    fullTitle: "Codex recent session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

describe("Recents Routes", () => {
  it("does not scan or prune visits absent from an incomplete retained catalog", async () => {
    const scan = vi.fn();
    const readerFactory = vi.fn();
    const pruneUnresolved = vi.fn();
    const catalog = {
      catalogEpoch: "empty",
      catalogGeneration: 0,
      complete: false,
      refreshing: true,
    };
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: () => [
          {
            sessionId: "unseen",
            projectId: "proj-1",
            visitedAt: "2026-01-01T00:00:00Z",
          },
        ],
        pruneUnresolved,
      } as unknown as RecentsService,
      scanner: { listProjects: scan } as unknown as ProjectScanner,
      readerFactory,
      retainedCollections: {
        read: async () => ({ rows: [], catalog }),
      } as unknown as RetainedSessionCollections,
    });
    const response = await routes.request("/?summaryMode=retained");
    expect(await response.json()).toEqual({
      recents: [],
      catalog,
      visits: [
        {
          sessionId: "unseen",
          projectId: "proj-1",
          visitedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(scan).not.toHaveBeenCalled();
    expect(readerFactory).not.toHaveBeenCalled();
    expect(pruneUnresolved).not.toHaveBeenCalled();
  });

  it("omits unobserved titles and uses the current project display name", async () => {
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: () => [
          {
            sessionId: "known",
            projectId: "proj-1",
            visitedAt: "2026-01-01T00:00:00Z",
          },
        ],
      } as unknown as RecentsService,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      projectDisplayName: (path) => `Renamed ${path}`,
      retainedCollections: {
        read: async () => ({
          rows: [
            {
              sessionId: "known",
              projectId: "proj-1",
              projectPath: "/work",
              catalogFamily: "pi",
            },
          ],
          catalog: {
            catalogEpoch: "one",
            catalogGeneration: 1,
            complete: true,
            refreshing: false,
          },
        }),
      } as unknown as RetainedSessionCollections,
    });
    const response = await routes.request("/?summaryMode=retained");
    const { recents } = await response.json();
    expect(recents[0]).toMatchObject({
      projectName: "Renamed /work",
      provider: "pi",
    });
    expect(recents[0]).not.toHaveProperty("title");
  });

  it("overlays the current Codex thread title on retained catalog rows", async () => {
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: () => [
          {
            sessionId: "codex-thread",
            projectId: "proj-1",
            visitedAt: "2026-01-01T00:00:00Z",
          },
        ],
      } as unknown as RecentsService,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      codexThreadTitleResolver: {
        getTitleOverride: (threadId) =>
          threadId === "codex-thread"
            ? { title: "Stale catalog title", fullTitle: "Current Codex title" }
            : null,
      },
      retainedCollections: {
        read: async () => ({
          rows: [
            {
              sessionId: "codex-thread",
              projectId: "proj-1",
              projectPath: "/work",
              catalogFamily: "codex",
              title: "Stale catalog title",
            },
          ],
          catalog: {
            catalogEpoch: "one",
            catalogGeneration: 1,
            complete: true,
            refreshing: false,
          },
        }),
      } as unknown as RetainedSessionCollections,
    });
    const response = await routes.request("/?summaryMode=retained");
    const { recents } = await response.json();
    expect(recents[0].title).toBe("Current Codex title");
  });

  it("resolves recent sessions across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "sess-1",
            projectId: "proj-1",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.recents).toHaveLength(1);
    expect(json.recents[0]).toMatchObject({
      sessionId: "sess-1",
      title: "Codex recent session",
      provider: "codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
  });

  it("prunes entries that resolve to no session", async () => {
    const pruneUnresolved = vi.fn(async () => {});
    const reader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "provisional-1",
            projectId: "proj-1",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
        pruneUnresolved,
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => [createProject()]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => reader),
    });

    const response = await routes.request("/");
    expect((await response.json()).recents).toEqual([]);
    expect(pruneUnresolved).toHaveBeenCalledWith(
      ["provisional-1"],
      expect.any(Number),
    );
  });

  it("records the superuser's visit but not a limited user's", async () => {
    const recordVisit = vi.fn(async () => {});
    const visitAs = async (principal: Principal) => {
      const app = new Hono<{
        Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
      }>();
      app.use("*", async (c, next) => {
        c.set(PRINCIPAL_VARIABLE, principal);
        await next();
      });
      app.route(
        "/",
        createRecentsRoutes({
          recentsService: { recordVisit } as unknown as RecentsService,
          scanner: {} as ProjectScanner,
          readerFactory: vi.fn(),
        }),
      );
      const response = await app.request("/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-1", projectId: "proj-1" }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    await expect(
      visitAs({
        kind: "limited",
        username: "alice",
        grants: {
          newSessionProjects: [],
          joinProjects: [],
          viewProjects: ["proj-1"],
          joinStaleOffsetMinutes: 0,
          lock: {},
        },
        switched: false,
        locked: true,
        via: "direct",
      }),
    ).resolves.toEqual({ recorded: false });
    expect(recordVisit).not.toHaveBeenCalled();

    await expect(visitAs(SUPERUSER)).resolves.toEqual({ recorded: true });
    expect(recordVisit).toHaveBeenCalledWith("sess-1", "proj-1");
  });
});
