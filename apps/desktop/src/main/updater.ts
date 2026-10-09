import { autoUpdater } from "electron-updater";
import { app, type BrowserWindow, ipcMain } from "electron";
import type {
  ManualUpdateCheckResult,
  UpdaterPreferences,
} from "../shared/updater-types";
import {
  loadUpdaterPreferences,
  saveUpdaterPreferences,
  updaterPreferencesPath,
} from "./updater-preferences";

// Fork review builds are replaced manually. Never arm electron-updater's
// download or quit-time installation, including for previously staged updates.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

const UPDATES_DISABLED_MESSAGE =
  "Updates are disabled in this fork review build. Replace the application manually with a newer reviewed build.";

export function setupAutoUpdater(_getMainWindow: () => BrowserWindow | null): void {
  const preferencesFilePath = updaterPreferencesPath(app.getPath("userData"));

  // Keep the IPC contract for existing renderer bundles without registering
  // update listeners, choosing an upstream feed, or scheduling any checks.
  ipcMain.handle("updater:download", () => {
    throw new Error(UPDATES_DISABLED_MESSAGE);
  });
  ipcMain.handle("updater:install", () => {
    throw new Error(UPDATES_DISABLED_MESSAGE);
  });
  ipcMain.handle("updater:get-preferences", (): Promise<UpdaterPreferences> =>
    loadUpdaterPreferences(preferencesFilePath),
  );
  ipcMain.handle(
    "updater:set-automatic-updates",
    async (_event, enabled: unknown): Promise<UpdaterPreferences> => {
      if (typeof enabled !== "boolean") {
        throw new TypeError("automaticUpdates must be a boolean");
      }
      const preferences = { automaticUpdates: false };
      await saveUpdaterPreferences(preferencesFilePath, preferences);
      return preferences;
    },
  );
  ipcMain.handle("updater:check", (): ManualUpdateCheckResult => ({
    ok: false,
    error: UPDATES_DISABLED_MESSAGE,
  }));
}
