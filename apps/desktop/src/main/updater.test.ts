// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoUpdater } from "electron-updater";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type IpcHandler = (...args: unknown[]) => unknown;

const ctx = vi.hoisted(() => ({
  ipcHandlers: new Map<string, IpcHandler>(),
  checkForUpdates: vi.fn(async () => ({
    updateInfo: { version: "0.3.18" },
    isUpdateAvailable: true,
  })),
  downloadUpdate: vi.fn(async () => ["downloaded.zip"]),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  userDataPath: "",
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: ctx.on,
    checkForUpdates: ctx.checkForUpdates,
    downloadUpdate: ctx.downloadUpdate,
    quitAndInstall: ctx.quitAndInstall,
  },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.3.17",
    getPath: () => ctx.userDataPath,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      ctx.ipcHandlers.set(channel, handler);
    },
  },
}));

import { setupAutoUpdater } from "./updater";
import { updaterPreferencesPath } from "./updater-preferences";

async function invokeIpc(channel: string, ...args: unknown[]) {
  const handler = ctx.ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({}, ...args);
}

describe("fork review-build update policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctx.userDataPath = mkdtempSync(join(tmpdir(), "multica-updater-test-"));
    ctx.ipcHandlers.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(ctx.userDataPath, { recursive: true, force: true });
  });

  it("disables updater automatic download and installation at module load", () => {
    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it.each([undefined, false, true])(
    "never schedules checks or update notifications with saved preference %s",
    async (savedPreference) => {
      if (savedPreference !== undefined) {
        writeFileSync(
          updaterPreferencesPath(ctx.userDataPath),
          JSON.stringify({ automaticUpdates: savedPreference }),
        );
      }
      const getWindow = vi.fn(() => null);
      setupAutoUpdater(getWindow);

      await expect(invokeIpc("updater:get-preferences")).resolves.toEqual({
        automaticUpdates: false,
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 5_000);
      expect(ctx.checkForUpdates).not.toHaveBeenCalled();
      expect(ctx.downloadUpdate).not.toHaveBeenCalled();
      expect(ctx.quitAndInstall).not.toHaveBeenCalled();
      expect(ctx.on).not.toHaveBeenCalled();
      expect(getWindow).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "persists false even when the renderer requests automatic updates %s",
    async (requestedPreference) => {
      writeFileSync(
        updaterPreferencesPath(ctx.userDataPath),
        JSON.stringify({ automaticUpdates: true }),
      );
      setupAutoUpdater(() => null);

      await expect(
        invokeIpc("updater:set-automatic-updates", requestedPreference),
      ).resolves.toEqual({ automaticUpdates: false });
      await expect(invokeIpc("updater:get-preferences")).resolves.toEqual({
        automaticUpdates: false,
      });
      expect(
        JSON.parse(readFileSync(updaterPreferencesPath(ctx.userDataPath), "utf-8")),
      ).toEqual({ automaticUpdates: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(ctx.checkForUpdates).not.toHaveBeenCalled();
      expect(ctx.downloadUpdate).not.toHaveBeenCalled();
      expect(ctx.quitAndInstall).not.toHaveBeenCalled();
    },
  );

  it("retains boolean validation for automatic update preferences", async () => {
    setupAutoUpdater(() => null);

    await expect(
      invokeIpc("updater:set-automatic-updates", "true"),
    ).rejects.toThrow("automaticUpdates must be a boolean");
    await invokeIpc("updater:get-preferences");
  });

  it("returns a compatible manual-check error without checking or downloading", async () => {
    setupAutoUpdater(() => null);

    await expect(invokeIpc("updater:check")).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/review build.*replace.*manually/i),
    });
    expect(ctx.checkForUpdates).not.toHaveBeenCalled();
    expect(ctx.downloadUpdate).not.toHaveBeenCalled();
    expect(ctx.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["updater:download", "updater:install"])(
    "rejects legacy %s IPC with manual replacement guidance",
    async (channel) => {
      setupAutoUpdater(() => null);

      await expect(invokeIpc(channel)).rejects.toThrow(
        /review build.*replace.*manually/i,
      );
      expect(ctx.checkForUpdates).not.toHaveBeenCalled();
      expect(ctx.downloadUpdate).not.toHaveBeenCalled();
      expect(ctx.quitAndInstall).not.toHaveBeenCalled();
    },
  );
});
