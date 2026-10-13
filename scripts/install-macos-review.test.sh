#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

setup_case() {
  local tmp="$1"
  mkdir -p "$tmp/bin" "$tmp/artifact" "$tmp/app/Contents" "$tmp/Applications/Multica.app/Contents"
  printf 'new\n' > "$tmp/app/Contents/build"
  printf 'old\n' > "$tmp/Applications/Multica.app/Contents/build"
  printf 'zip\n' > "$tmp/artifact/multica-desktop-0.6.1-55-gcc0e36d65-mac-arm64.zip"
  printf 'dmg\n' > "$tmp/artifact/multica-desktop-0.6.1-55-gcc0e36d65-mac-arm64.dmg"
  (cd "$tmp/artifact" && shasum -a 256 multica-desktop-0.6.1-55-gcc0e36d65-mac-arm64.{dmg,zip} > SHA256SUMS.txt)
  printf '{"repository":"j8d/multica","commit":"%s","runUrl":"https://github.com/j8d/multica/actions/runs/123","architecture":"arm64","signing":"ad-hoc (no Developer ID)","notarized":false,"version":"0.6.1-55-gcc0e36d65"}\n' "$COMMIT" > "$tmp/artifact/REVIEW-BUILD.json"

  cat > "$tmp/bin/uname" <<'STUB'
#!/usr/bin/env bash
case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac
STUB
  cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "run list" ]]; then
  printf '123 %s\n' "$REVIEW_TEST_COMMIT"
elif [[ "$1 $2" == "run download" ]]; then
  destination=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -D) destination="$2"; shift 2 ;;
      -n)
        [[ "$2" == "multica-macos-arm64-adhoc-review-$REVIEW_TEST_COMMIT" ]] || exit 2
        shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$REVIEW_TEST_ARTIFACT"/* "$destination/"
else
  exit 2
fi
STUB
  cat > "$tmp/bin/ditto" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "-x" ]]; then
  cp -R "$REVIEW_TEST_APP" "$4/Multica.app"
else
  cp -R "$1" "$2"
fi
STUB
  cat > "$tmp/bin/lipo" <<'STUB'
#!/usr/bin/env bash
echo arm64
STUB
  cat > "$tmp/bin/plutil" <<'STUB'
#!/usr/bin/env bash
case "$2" in
  CFBundleIdentifier) echo ai.multica.desktop ;;
  CFBundleShortVersionString) echo "${REVIEW_TEST_BUNDLE_VERSION:-0.6.1-55-gcc0e36d65}" ;;
  *) exit 1 ;;
esac
STUB
  cat > "$tmp/bin/mv" <<'STUB'
#!/usr/bin/env bash
if [[ "${REVIEW_TEST_FAIL_SWAP:-0}" == 1 && "$1" == */.multica-review.*/Multica.app ]]; then
  exit 1
fi
exec /bin/mv "$@"
STUB
  cat > "$tmp/bin/codesign" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "-dv" ]]; then
  printf 'Signature=%s\n' "${REVIEW_TEST_SIGNATURE:-adhoc}" >&2
  exec seq 1 10000 >&2
fi
STUB
  cat > "$tmp/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
[[ "${REVIEW_TEST_RUNNING:-0}" == 1 ]]
STUB
  chmod +x "$tmp/bin"/*
}

run_installer() {
  local tmp="$1"
  PATH="$tmp/bin:$PATH" REVIEW_TEST_COMMIT="$COMMIT" \
    REVIEW_TEST_ARTIFACT="$tmp/artifact" REVIEW_TEST_APP="$tmp/app" \
    bash "$ROOT_DIR/scripts/install-macos-review.sh" --app-dir "$tmp/Applications" \
    > "$tmp/stdout" 2> "$tmp/stderr"
}

test_installs_verified_review_build() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  run_installer "$tmp"
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == new ]]
  [[ -z "$(find "$tmp/Applications" -maxdepth 1 -name '.multica-review.*' -print)" ]]
}

test_rejects_mismatched_provenance_without_replacement() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  jq '.commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
    "$tmp/artifact/REVIEW-BUILD.json" > "$tmp/metadata"
  mv "$tmp/metadata" "$tmp/artifact/REVIEW-BUILD.json"
  if run_installer "$tmp"; then
    echo "mismatched commit must fail" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_rejects_modified_archive_without_replacement() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  printf 'modified\n' > "$tmp/artifact/multica-desktop-0.6.1-55-gcc0e36d65-mac-arm64.zip"
  if run_installer "$tmp"; then
    echo "checksum mismatch must fail" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_rejects_wrong_bundle_version_without_replacement() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  if REVIEW_TEST_BUNDLE_VERSION=0.6.1 run_installer "$tmp"; then
    echo "mismatched bundle version must fail" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_rejects_non_ad_hoc_signature_without_replacement() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  if REVIEW_TEST_SIGNATURE=none run_installer "$tmp"; then
    echo "non-ad-hoc signature must fail" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_refuses_to_replace_running_app() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  if REVIEW_TEST_RUNNING=1 run_installer "$tmp"; then
    echo "running app must not be replaced" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_restores_previous_app_on_swap_failure() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  setup_case "$tmp"
  if REVIEW_TEST_FAIL_SWAP=1 run_installer "$tmp"; then
    echo "failed app swap must report failure" >&2
    return 1
  fi
  [[ "$(cat "$tmp/Applications/Multica.app/Contents/build")" == old ]]
}

test_installs_verified_review_build
test_rejects_mismatched_provenance_without_replacement
test_rejects_modified_archive_without_replacement
test_rejects_wrong_bundle_version_without_replacement
test_rejects_non_ad_hoc_signature_without_replacement
test_refuses_to_replace_running_app
test_restores_previous_app_on_swap_failure
echo "install-macos-review.sh tests passed"
