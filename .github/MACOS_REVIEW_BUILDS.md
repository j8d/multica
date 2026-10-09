# macOS ARM64 review builds (j8d fork)

This fork distributes **unsigned/ad-hoc review artifacts**, not Developer ID
signed or notarized releases. Building on GitHub avoids compiling on a managed
work Mac; it does not grant permission to install or run the result there.
Obtain security-team approval. Do not disable Gatekeeper, quarantine, MDM, or
endpoint protection to install this build.

## Build and download

After the PR adding the workflow is merged:

1. Open this fork's **Actions → macOS ARM64 Review Build → Run workflow**.
2. Select `main` (or a reviewed branch) and run it. The workflow runs on an
   Apple Silicon macOS runner, without Apple credentials or release-write access.
3. Wait for all tests, packaging, and archive verification to pass.
4. Open the successful run and download the artifact named
   `multica-macos-arm64-adhoc-review-<commit>`.
5. Extract the artifact ZIP. It contains the application DMG and ZIP,
   `SHA256SUMS.txt`, and `REVIEW-BUILD.json`. On an approved machine, verify:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

6. Give security the files, source commit/PR, and workflow URL. Only after
   approval, mount the DMG and copy `Multica.app` to Applications, or follow
   IT's deployment procedure. A DMG is not a managed `.pkg` installer.

Artifacts expire after 14 days. Re-running the selected reviewed source creates
fresh artifacts; no GitHub Release, tag, container, Homebrew formula, or update
feed is published by this workflow. Avoid creating version tags casually: the
inherited upstream `Release` workflow still has container-publishing jobs.

## Fork integrity

- Desktop update checks, downloads, installation, and enabling automatic updates
  are disabled, even when old user preferences enabled them. Replace the app
  manually with another approved fork build. No Electron release publisher is
  configured.
- The app requires the CLI bundled from the same checkout. If it is missing or
  unusable, startup reports failure. It never repairs itself with an upstream
  download, a previously managed CLI, or a CLI found on PATH.
- Go is mandatory at build time; a missing toolchain cannot silently reuse an
  old binary. The archive verifier checks ARM64 executable architecture,
  signatures, renderer assets, embedded CLI commit, LICENSE/NOTICE, and absence
  of the upstream recovery URL/update feed in the packaged app.
- The optional agent discovery change from PR #1 remains in effect: automatic
  OpenClaw discovery is off; an explicitly configured path still opts in. Other
  agent providers retain their existing discovery behavior. This is not a claim
  that every runtime operation has been approved by corporate security.
- Standalone CLI self-update commands remain upstream-oriented; do not use this
  app's embedded binary as a separately managed CLI. Desktop-managed daemons
  already skip their own automatic CLI update loop.

## Verification and limitations

The workflow runs the focused fake-executable discovery regression, Go test
wrapper checks, CLI vulnerability scan, desktop typecheck/lint/tests, packaging,
and verification of the *actual* DMG/ZIP contents. It does not launch the app or
daemon, contact real agent accounts, or test installation on a physical M4 Mac.
The only CLI command executed during archive verification is `--version`.

The app version is derived from existing Git tags/history; the artifact name and
provenance record identify the exact source commit. No version tag is needed for
review builds. Checksums detect accidental modification; they are not a trusted
publisher signature. Ad-hoc signing provides no verified developer identity and
no notarization ticket, so a managed Mac can still block these packages.

Visible Multica branding and the full LICENSE/NOTICE are retained under the
repository's additional license conditions. A future signed release or managed
PKG requires a separate distribution decision and implementation.
