import { app } from "electron";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export const BUNDLED_CLI_UNAVAILABLE_MESSAGE =
  "The bundled CLI is missing or unusable in this fork review build. Replace the application manually with a complete reviewed build; managed CLI installation, PATH fallback, and upstream downloads are disabled.";

/**
 * Require the CLI shipped in the same review build. Never repair from a
 * managed installation, PATH, or an upstream release.
 *
 * electron-builder unpacks resources/** beside app.asar; development uses
 * apps/desktop/resources/bin directly.
 */
export async function resolveBundledCli(): Promise<{
  path: string;
  version: string;
} | null> {
  const name = process.platform === "win32" ? "multica.exe" : "multica";
  const path = join(app.getAppPath(), "resources", "bin", name).replace(
    "app.asar",
    "app.asar.unpacked",
  );
  if (existsSync(path)) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          path,
          ["version", "--output", "json"],
          { timeout: 5_000 },
          (err, out) => {
            if (err) reject(err);
            else resolve(out);
          },
        );
      });
      const parsed = JSON.parse(stdout) as { version?: unknown } | null;
      if (typeof parsed?.version === "string" && parsed.version.trim().length > 0) {
        return { path, version: parsed.version };
      }
    } catch (err) {
      console.warn(`[daemon] bundled CLI validation failed at ${path}:`, err);
    }
  }
  console.warn(`[daemon] ${BUNDLED_CLI_UNAVAILABLE_MESSAGE} (${path})`);
  return null;
}
