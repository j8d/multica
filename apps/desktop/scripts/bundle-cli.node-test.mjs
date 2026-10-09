import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const f = fixture(t);
  const staleDir = join(f.root, "server", "bin", "darwin-arm64");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "multica"), "stale binary");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Go is required/);
  assert.equal(existsSync(join(f.root, "apps", "desktop", "resources", "bin", "multica")), false);
});

test("a build that reports success without producing a CLI fails closed", (t) => {
  if (process.platform === "win32") return t.skip("fake shell tool is Unix-only");
  const f = fixture(t);
  writeFileSync(join(f.tools, "go"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not present/);
  assert.equal(existsSync(join(f.root, "apps", "desktop", "resources", "bin", "multica")), false);
});
