import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "multica-bundle-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps", "desktop", "scripts");
  const tools = join(root, "tools");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tools);
  for (const name of ["bundle-cli.mjs", "package.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), join(scripts, name));
  }
  return { root, scripts, tools };
}

function run({ root, scripts, tools }) {
  return spawnSync(process.execPath, [join(scripts, "bundle-cli.mjs"), "--target-platform", "darwin", "--target-arch", "arm64"], {
    cwd: root,
    env: { ...process.env, PATH: tools },
    encoding: "utf8",
  });
}

test("missing Go rejects even a stale compiled CLI instead of copying it", (t) => {
  const fixtureState = fixture(t);
  const staleDir = join(fixtureState.root, "server", "bin", "darwin-arm64");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "multica"), "stale binary");
  const result = run(fixtureState);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Go is required/);
  assert.equal(existsSync(join(fixtureState.root, "apps", "desktop", "resources", "bin", "multica")), false);
});

test("a build that reports success without producing a CLI fails closed", (t) => {
  if (process.platform === "win32") return t.skip("fake shell tool is Unix-only");
  const fixtureState = fixture(t);
  writeFileSync(join(fixtureState.tools, "go"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = run(fixtureState);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present/);
  assert.equal(existsSync(join(fixtureState.root, "apps", "desktop", "resources", "bin", "multica")), false);
});

const fullRevision = "a".repeat(40);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));

function fakeExecutable(path, source) {
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

for (const [platform, arch, goos, goarch, foreignCaller] of [
  ["darwin", "arm64", "darwin", "arm64", false],
  ["linux", "x64", "linux", "amd64", false],
  ["win32", "arm64", "windows", "arm64", false],
  ["darwin", "arm64", "darwin", "arm64", true],
  ["linux", "x64", "linux", "amd64", true],
  ["win32", "arm64", "windows", "arm64", true],
]) {
  for (const missingRevision of [false, true]) {
    test(`bundled ${platform}/${arch} preserves source-root commit (missing=${missingRevision}, foreignCaller=${foreignCaller})`, () => {
      const root = mkdtempSync(join(tmpdir(), "multica-bundle-commit-"));
      try {
        const scripts = join(root, "apps", "desktop", "scripts");
        const bin = join(root, "fake-bin");
        const record = join(root, "build.json");
        const caller = join(root, "foreign-caller");
        mkdirSync(scripts, { recursive: true });
        mkdirSync(bin);
        mkdirSync(join(root, "server"));
        mkdirSync(caller);
        for (const name of ["bundle-cli.mjs", "package.mjs"]) {
          copyFileSync(join(scriptDir, name), join(scripts, name));
        }
        fakeExecutable(join(bin, "git"), `
const args = process.argv.slice(2);
if (args[0] === "describe") console.log("v9.9.9");
else if (args.join(" ") === "rev-parse --short HEAD") console.log("abc1234");
else if (args.join(" ") === "rev-parse HEAD") {
  if (process.env.TEST_MISSING_REVISION === "true") process.exit(1);
  console.log(process.cwd() === process.env.TEST_SOURCE_ROOT ? ${JSON.stringify(fullRevision)} : "b".repeat(40));
} else process.exit(2);
`);
        fakeExecutable(join(bin, "go"), `
const args = process.argv.slice(2);
if (args[0] === "version") console.log("go version go1.27.1 fake/fake");
else if (args[0] === "build") {
  const fs = await import("node:fs");
  fs.writeFileSync(process.env.TEST_BUILD_RECORD, JSON.stringify({args, goos:process.env.GOOS, goarch:process.env.GOARCH, cgo:process.env.CGO_ENABLED}));
  fs.writeFileSync(args[args.indexOf("-o") + 1], "fake artifact");
} else process.exit(2);
`);
        fakeExecutable(join(bin, "codesign"), "process.exit(0);\n");
        execFileSync(process.execPath, [join(scripts, "bundle-cli.mjs"), "--target-platform", platform, "--target-arch", arch], {
          cwd: foreignCaller ? caller : root,
          env: { PATH: bin, HOME: root, TEST_SOURCE_ROOT: realpathSync(root), TEST_BUILD_RECORD: record, TEST_MISSING_REVISION: String(missingRevision) },
          stdio: "pipe",
        });
        const build = JSON.parse(readFileSync(record, "utf8"));
        const flags = build.args[build.args.indexOf("-ldflags") + 1].split(" ");
        assert.ok(flags.includes("main.version=9.9.9"));
        assert.ok(flags.includes("main.commit=abc1234"));
        assert.ok(flags.includes(`main.buildCommit=${missingRevision ? "unknown" : fullRevision}`));
        assert.equal(build.goos, goos);
        assert.equal(build.goarch, goarch);
        assert.equal(build.cgo, "0");
        const artifact = platform === "win32" ? "multica.exe" : "multica";
        assert.equal(readFileSync(join(root, "apps", "desktop", "resources", "bin", artifact), "utf8"), "fake artifact");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
