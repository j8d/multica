#!/usr/bin/env bash
set -euo pipefail

repo="j8d/multica"
app_dir="$HOME/Applications"
if [[ $# -gt 0 ]]; then
  if [[ $# -ne 2 || "$1" != "--app-dir" || "$2" != /* ]]; then
    echo "Usage: bash scripts/install-macos-review.sh [--app-dir /absolute/path]" >&2
    exit 2
  fi
  app_dir="$2"
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This review build requires an Apple Silicon Mac." >&2
  exit 1
fi
for tool in gh jq shasum ditto lipo codesign plutil pgrep; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required command: $tool" >&2
    exit 1
  fi
done

run="$(gh run list -R "$repo" -w macos-review.yml -b main -s success -L 1 \
  --json databaseId,headSha --jq '.[0] | if . == null then empty else "\(.databaseId) \(.headSha)" end')"
read -r run_id commit <<< "$run"
if [[ ! "$run_id" =~ ^[0-9]+$ || ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "No successful main-branch macOS review build found." >&2
  exit 1
fi

work="$(mktemp -d)"
stage=""
cleanup() {
  rm -rf "$work"
  if [[ -n "$stage" ]]; then
    if [[ -d "$stage/previous.app" ]]; then
      echo "Previous app preserved at $stage/previous.app; restore it manually." >&2
    else
      rm -rf "$stage"
    fi
  fi
}
trap cleanup EXIT
artifact="multica-macos-arm64-adhoc-review-$commit"
gh run download "$run_id" -R "$repo" -n "$artifact" -D "$work"

metadata="$work/REVIEW-BUILD.json"
if [[ ! -f "$metadata" ]] || ! jq -e --arg repo "$repo" --arg commit "$commit" \
  --arg url "https://github.com/$repo/actions/runs/$run_id" \
  '.repository == $repo and .commit == $commit and .runUrl == $url and
   .architecture == "arm64" and .signing == "ad-hoc (no Developer ID)" and .notarized == false' \
  "$metadata" >/dev/null; then
  echo "Review build provenance does not match the selected run." >&2
  exit 1
fi
version="$(jq -er '.version | strings' "$metadata")"
if [[ ! "$version" =~ ^[0-9][A-Za-z0-9.+-]*$ ]]; then
  echo "Invalid review build version." >&2
  exit 1
fi
zip="multica-desktop-${version}-mac-arm64.zip"
dmg="multica-desktop-${version}-mac-arm64.dmg"
if [[ ! -f "$work/$zip" || ! -f "$work/$dmg" || ! -f "$work/SHA256SUMS.txt" ]] ||
  [[ $(wc -l < "$work/SHA256SUMS.txt") -ne 2 ]] ||
  ! awk -v zip="$zip" -v dmg="$dmg" '
    NF != 2 || $1 !~ /^[[:xdigit:]]{64}$/ || ($2 != zip && $2 != dmg) { exit 1 }
    { seen[$2]++ }
    END { if (seen[zip] != 1 || seen[dmg] != 1) exit 1 }
  ' "$work/SHA256SUMS.txt"; then
  echo "Review artifact is incomplete or has unexpected checksums." >&2
  exit 1
fi
(cd "$work" && shasum -a 256 -c SHA256SUMS.txt)

mkdir "$work/extracted"
ditto -x -k "$work/$zip" "$work/extracted"
app="$work/extracted/Multica.app"
cli="$app/Contents/Resources/app.asar.unpacked/resources/bin/multica"
if [[ ! -d "$app" || -L "$app" ]]; then
  echo "Review archive does not contain a regular Multica.app." >&2
  exit 1
fi
if [[ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" != "ai.multica.desktop" ]] ||
  [[ "$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")" != "$version" ]]; then
  echo "Review app bundle identity or version does not match provenance." >&2
  exit 1
fi
if [[ "$(lipo -archs "$app/Contents/MacOS/Multica")" != "arm64" ]] ||
  [[ "$(lipo -archs "$cli")" != "arm64" ]]; then
  echo "Review app or bundled CLI is not arm64." >&2
  exit 1
fi
if ! codesign --verify --deep --strict "$app" ||
  ! codesign --verify --strict "$cli"; then
  echo "Review app or bundled CLI code signature verification failed." >&2
  exit 1
fi
if ! signature_details="$(codesign -dv --verbose=2 "$app" 2>&1)" ||
  [[ "$signature_details" != *'Signature=adhoc'* ]]; then
  echo "Review app is not ad-hoc signed." >&2
  exit 1
fi

target="$app_dir/Multica.app"
if [[ "$app_dir" == "$HOME/Applications" && -e /Applications/Multica.app ]]; then
  echo "An app exists in /Applications. Use --app-dir /Applications to replace it explicitly." >&2
  exit 1
fi
if pgrep -x Multica >/dev/null; then
  echo "Quit Multica before installing the review build." >&2
  exit 1
fi
if [[ -L "$app_dir" || -L "$target" || ( -e "$target" && ! -d "$target" ) ]]; then
  echo "Installation path is not an application directory." >&2
  exit 1
fi
mkdir -p "$app_dir"
if [[ ! -w "$app_dir" ]]; then
  echo "Cannot write to $app_dir; ask IT to deploy the reviewed artifact." >&2
  exit 1
fi
stage="$(mktemp -d "$app_dir/.multica-review.XXXXXX")"
ditto "$app" "$stage/Multica.app"
if [[ -d "$target" ]]; then
  mv "$target" "$stage/previous.app"
fi
if ! mv "$stage/Multica.app" "$target"; then
  if [[ -d "$stage/previous.app" ]]; then
    mv "$stage/previous.app" "$target"
  fi
  echo "Installation failed; previous app restored." >&2
  exit 1
fi
rm -rf "$stage/previous.app"
echo "Installed $target from $repo run $run_id ($commit)."
