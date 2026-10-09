// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

type IpcHandler = (...args: unknown[]) => unknown;
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const ctx = vi.hoisted(() => ({
  appPath: "/review/Multica.app/Contents/Resources/app.asar",
  ipcHandlers: new Map<string, IpcHandler>(),
  existsSync: vi.fn(),
  execFile: vi.fn(),
  fetch: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => ctx.appPath,
    getPath: () => "/review/userData",
    on: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ctx.ipcHandlers.set(channel, handler);
    },
    on: vi.fn(),
  },
  BrowserWindow: class {},
  shell: { openPath: vi.fn() },
}));
vi.mock("child_process", () => ({ execFile: ctx.execFile }));
vi.mock("fs", () => ({
  existsSync: ctx.existsSync,
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  readFile: ctx.readFile,
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  chmod: vi.fn(),
  rename: vi.fn(),
}));

function bundledPath() {
  const name = process.platform === "win32" ? "multica.exe" : "multica";
  return join(ctx.appPath, "resources", "bin", name).replace(
    "app.asar",
    "app.asar.unpacked",
  );
}

async function invokeIpc(channel: string, ...args: unknown[]) {
  const handler = ctx.ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({}, ...args);
}

async function setupManager() {
  const { setupDaemonManager } = await import("./daemon-manager");
  setupDaemonManager(() => null);
}

function expectNoFallback() {
  expect(ctx.fetch).not.toHaveBeenCalled();
  expect(ctx.existsSync.mock.calls.map(([path]) => path)).toEqual(
    expect.arrayContaining([bundledPath()]),
  );
  expect(ctx.existsSync.mock.calls.every(([path]) => path === bundledPath())).toBe(true);
  expect(ctx.execFile.mock.calls.every(([path]) => path === bundledPath())).toBe(true);
}

describe("fork review-build bundled CLI policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    ctx.appPath = "/review/Multica.app/Contents/Resources/app.asar";
    ctx.ipcHandlers.clear();
    // Fallback binaries exist and work: the policy must reject them, not just
    // happen to fail because the machine has no managed or PATH installation.
    ctx.existsSync.mockImplementation(() => true);
    ctx.execFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(null, JSON.stringify({ version: "fork-review" }), "");
      },
    );
    ctx.fetch.mockRejectedValue(new Error("Unexpected network access"));
    ctx.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    vi.stubGlobal("fetch", ctx.fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["packaged", "development"])(
    "validates and caches only the %s bundled binary",
    async (layout) => {
      if (layout === "development") ctx.appPath = "/review/apps/desktop";
      await setupManager();

      await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(true);
      await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(true);
      expect(ctx.execFile).toHaveBeenCalledTimes(1);
      expect(ctx.execFile).toHaveBeenCalledWith(
        bundledPath(),
        ["version", "--output", "json"],
        expect.objectContaining({ timeout: 5_000 }),
        expect.any(Function),
      );
      expectNoFallback();
    },
  );

  it.each(["managed", "PATH"])(
    "fails closed when the bundle is missing even with a usable %s CLI",
    async (fallback) => {
      ctx.existsSync.mockImplementation((path: string) => {
        if (path === bundledPath()) return false;
        if (path.includes("userData")) return fallback === "managed";
        return true;
      });
      await setupManager();

      await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(false);
      await expect(invokeIpc("daemon:get-status")).resolves.toEqual({ state: "cli_not_found" });
      for (const channel of ["daemon:start", "daemon:stop", "daemon:restart"]) {
        await expect(invokeIpc(channel)).resolves.toEqual({
          success: false,
          error: expect.stringMatching(/bundled CLI.*review build.*replace.*manually/i),
        });
      }
      await invokeIpc("daemon:auto-start");
      expect(ctx.execFile).not.toHaveBeenCalled();
      expectNoFallback();
    },
  );

  it.each([
    ["spawn failure", "", new Error("EACCES")],
    ["malformed JSON", "not-json", null],
    ["missing version", "{}", null],
    ["empty version", '{"version":""}', null],
    ["null output", "null", null],
  ])("fails closed for an unusable bundled CLI: %s", async (_reason, output, error) => {
    ctx.execFile.mockImplementation(
      (bin: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callback(
          bin === bundledPath() ? error : null,
          bin === bundledPath() ? output : '{"version":"upstream"}',
          "",
        );
      },
    );
    await setupManager();

    await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(false);
    await expect(invokeIpc("daemon:start")).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/bundled CLI.*review build.*replace.*manually/i),
    });
    expect(ctx.execFile).toHaveBeenCalledTimes(1);
    expectNoFallback();
  });

  it("legacy retry-install only revalidates the bundle and never installs a fallback", async () => {
    ctx.existsSync.mockImplementation((path: string) => path !== bundledPath());
    await setupManager();
    await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(false);

    await expect(invokeIpc("daemon:retry-install")).resolves.toBeUndefined();
    await expect(invokeIpc("daemon:is-cli-installed")).resolves.toBe(false);
    expect(ctx.execFile).not.toHaveBeenCalled();
    expectNoFallback();
  });
});
