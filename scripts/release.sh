#!/usr/bin/env bash
# release.sh — the one manual step in a release.
#
#   scripts/release.sh bump 1.1.0    on a fresh branch from main: set the version
#                                    in metadata.json, package.json and
#                                    package-lock.json, and commit it
#
# Open a pull request from that branch. Merging it is the release: on main,
# release.yml sees a version-name with no tag yet, runs the compat matrix,
# tags the merge commit v1.1.0, publishes the GitHub release and uploads the
# zip to extensions.gnome.org's review queue.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ "${1:-}" == bump && -n "${2:-}" ]] || usage
VERSION="$2"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release.sh: '$VERSION' is not X.Y.Z" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo "release.sh: the working tree is not clean" >&2; exit 1; }
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "release.sh: v$VERSION is already released" >&2
  exit 1
fi

# JSON.stringify(_, null, 2) is the format metadata.json is already in, so the
# diff is the one line that changed.
node -e '
  const fs = require("fs");
  const meta = JSON.parse(fs.readFileSync("metadata.json", "utf8"));
  meta["version-name"] = process.argv[1];
  fs.writeFileSync("metadata.json", JSON.stringify(meta, null, 2) + "\n");
' "$VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

git add metadata.json package.json package-lock.json
git commit -q -m "Release $VERSION"
git --no-pager show --stat --oneline HEAD
echo
echo "Next: push this branch and open a pull request. Merging it releases v$VERSION."
