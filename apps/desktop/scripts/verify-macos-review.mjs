#!/usr/bin/env node
// Validate the actual DMG and ZIP without launching the app or probing agents.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveVersion } from "./package.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(desktopRoot, "dist");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", cwd: desktopRoot }).trim();
assert.equal(process.platform, "darwin", "Package verification requires macOS");
assert.equal(process.arch, "arm64", "Review runner must be Apple Silicon");
assert.equal(run("git", ["status", "--porcelain"]), "", "Review source must be clean");
const commit = run("git", ["rev-parse", "HEAD"]);
const shortCommit = run("git", ["rev-parse", "--short", "HEAD"]);
const expectedVersion = deriveVersion(desktopRoot);
assert.ok(expectedVersion, "Review version must be derived from source history");
const localRequire = createRequire(join(desktopRoot, "package.json"));
const builderRequire = createRequire(localRequire.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = appBuilderRequire("@electron/asar");
const archives = readdirSync(dist).filter((name) => /\.(dmg|zip)$/.test(name));
assert.equal(archives.filter((name) => name.endsWith(".dmg")).length, 1);
assert.equal(archives.filter((name) => name.endsWith(".zip")).length, 1);
assert.ok(archives.every((name) => name.includes("-mac-arm64.")));

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function inspectApp(app) {
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  const cli = join(resources, "app.asar.unpacked", "resources", "bin", "multica");
  const archive = join(resources, "app.asar");
  assert.equal(run("lipo", ["-archs", join(contents, "MacOS", "Multica")]), "arm64");
  assert.equal(run("lipo", ["-archs", cli]), "arm64");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  run("codesign", ["--verify", "--strict", cli]);
  const signature = spawnSync("codesign", ["-d", "-vv", app], { encoding: "utf8" });
  assert.equal(signature.status, 0);
  assert.match(signature.stderr, /Signature=adhoc/, "Review app must be ad-hoc signed");
  assert.ok(existsSync(join(resources, "LICENSE")));
  assert.ok(existsSync(join(resources, "NOTICE")));
  assert.equal(existsSync(join(resources, "app-update.yml")), false, "No publisher/update feed allowed");
  const goMetadata = run("go", ["version", "-m", cli]);
  assert.equal(goMetadata.match(/\tbuild\tvcs\.revision=(\S+)/)?.[1], commit, "Embedded CLI source revision mismatch");
  assert.equal(goMetadata.match(/\tbuild\tvcs\.modified=(\S+)/)?.[1], "false", "Embedded CLI was built from dirty source");
  // --version is deliberately not a daemon/discovery command.
  const cliVersion = run(cli, ["--version"]);
  assert.ok(cliVersion.startsWith(`multica ${expectedVersion} (commit: ${shortCommit},`), "CLI version/commit must match reviewed source");
  const files = asar.listPackage(archive);
  assert.ok(files.includes("/out/renderer/index.html"), "Renderer entry point missing");
  assert.ok(files.some((path) => path.startsWith("/out/renderer/assets/") && path.endsWith(".js")), "Renderer JS missing");
  const main = asar.extractFile(archive, "out/main/index.js").toString("utf8");
  assert.equal(main.includes("multica-ai/multica/releases"), false, "Upstream CLI recovery URL remains");
  const version = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8")).version;
  assert.equal(version, expectedVersion, "Desktop version must match the CLI and source history");
  return { version, cliVersion, goMetadata };
}

const checksums = [];
let provenance;
for (const name of archives.sort()) {
  const work = mkdtempSync(join(tmpdir(), "multica-review-verify-"));
  let mounted = false;
  try {
    let app;
    if (name.endsWith(".dmg")) {
      run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", work, join(dist, name)]);
      mounted = true;
      app = join(work, "Multica.app");
    } else {
      run("ditto", ["-x", "-k", join(dist, name), work]);
      app = join(work, "Multica.app");
    }
    const metadata = inspectApp(app);
    if (provenance) assert.equal(metadata.version, provenance.version);
    provenance = metadata;
    checksums.push(`${await sha256(join(dist, name))}  ${name}`);
  } finally {
    if (mounted) run("hdiutil", ["detach", work]);
    rmSync(work, { recursive: true, force: true });
  }
}
writeFileSync(join(dist, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
writeFileSync(join(dist, "REVIEW-BUILD.json"), JSON.stringify({
  repository: process.env.GITHUB_REPOSITORY ?? "j8d/multica",
  commit,
  runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  ...provenance,
  architecture: "arm64",
  signing: "ad-hoc (no Developer ID)",
  notarized: false,
  updates: "manual package replacement only; bundled CLI required",
  warning: "Review artifact only. Corporate installation approval is separate. No app/daemon launch test was performed.",
}, null, 2) + "\n");
console.log(`Verified ${archives.join(", ")} at ${commit}`);
