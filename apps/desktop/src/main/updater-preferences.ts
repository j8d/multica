import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UpdaterPreferences } from "../shared/updater-types";

export const DEFAULT_UPDATER_PREFERENCES: UpdaterPreferences = {
  automaticUpdates: false,
};

export function updaterPreferencesPath(userDataPath: string): string {
  return join(userDataPath, "updater-preferences.json");
}

// Review-build policy is unconditional, not a preference a saved file can undo.
export async function loadUpdaterPreferences(
  _filePath: string,
): Promise<UpdaterPreferences> {
  return { automaticUpdates: false };
}

export async function saveUpdaterPreferences(
  filePath: string,
  _preferences: UpdaterPreferences,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ automaticUpdates: false }, null, 2),
    "utf-8",
  );
  await rename(temporaryPath, filePath);
}
