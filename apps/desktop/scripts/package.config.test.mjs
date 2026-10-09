// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builderArgsForTarget,
  parsePackageArgs,
  resolveBuildMatrix,
} from "./package.mjs";

const desktopRoot = [
  process.cwd(),
  resolve(process.cwd(), "apps/desktop"),
].find((candidate) => existsSync(resolve(candidate, "electron-builder.yml")));
const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
// Resolve parser/config dependencies through the declared electron-builder
// dependency, including in pnpm's isolated dependency layout.
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { configureBuildCommand, createYargs, normalizeOptions } = builderRequire(
  "electron-builder/out/builder.js",
);
const { getConfig, validateConfiguration } = builderRequire(
  "app-builder-lib/out/util/config/config.js",
);
const { DebugLogger } = builderRequire("builder-util");
const { load } = builderRequire("js-yaml");

async function effectiveConfiguration(builderArgs) {
  // Exercise the real CLI parser, normalization, on-disk config merge, and
  // schema, without invoking a build, signing, publishing, or an agent CLI.
  const options = normalizeOptions(
    configureBuildCommand(createYargs()).exitProcess(false).parse(builderArgs),
  );
  const config = await getConfig(desktopRoot, undefined, options.config);
  await validateConfiguration(config, new DebugLogger(false));
  return { options, config };
}

describe("effective electron-builder configuration", () => {
  it("accepts the exact ad-hoc review workflow arguments without a publisher", async () => {
    const workflow = load(
      readFileSync(
        resolve(desktopRoot, "../../.github/workflows/macos-review.yml"),
        "utf-8",
      ),
    );
    const job = workflow.jobs.review;
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(job.env.APPLE_TEAM_ID).toBe("");
    expect(job.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    const step = job.steps.find(
      (entry) => entry.name === "Package ad-hoc review DMG and ZIP",
    );
    expect(step["working-directory"]).toBe("apps/desktop");
    // This workflow command is a literal argv list, not a shell expansion.
    const [command, script, ...argv] = step.run.trim().split(/\s+/);
    expect([command, script]).toEqual(["node", "scripts/package.mjs"]);
    const parsed = parsePackageArgs(argv);
    const targets = resolveBuildMatrix(parsed, "darwin", "arm64");
    expect(targets).toEqual([{ platform: "mac", arch: "arm64" }]);
    const { options, config } = await effectiveConfiguration(
      builderArgsForTarget(targets[0], parsed, "1.2.3", {
        disableMacNotarize: !job.env.APPLE_TEAM_ID,
        hostPlatform: "darwin",
        useScopedOutputDir: targets.length > 1,
      }),
    );
    expect(options.publish).toBe("never");
    expect(config.publish).toBeNull();
    expect(config.mac.identity).toBe("-");
    expect(config.mac.notarize).toBe(false);
    expect(config.mac.target).toEqual(["dmg", "zip"]);
    expect(config.extraMetadata.version).toBe("1.2.3");
    expect(config.directories.output).toBe("dist");
  });

  const parsed = parsePackageArgs(["--all-platforms", "--publish", "never"]);
  const targets = resolveBuildMatrix(parsed, "darwin", "arm64");
  it.each(targets)(
    "keeps publish:null schema-valid for $platform $arch",
    async (target) => {
      const { options, config } = await effectiveConfiguration(
        builderArgsForTarget(target, parsed, "1.2.3", {
          disableMacNotarize: true,
          hostPlatform: "darwin",
          useScopedOutputDir: true,
        }),
      );
      expect(options.publish).toBe("never");
      expect(config.publish).toBeNull();
      expect(config.mac.notarize).toBe(false);
      expect(config.extraMetadata.version).toBe("1.2.3");
      expect(config.directories.output).toBe(
        `dist/${target.platform}-${target.arch}`,
      );
      if (target.platform === "mac" && target.arch === "x64") {
        expect(config.mac.minimumSystemVersion).toBe("12.0.0");
      }
    },
  );
});
