#!/bin/zsh
# Publishes the current VERSION: tags v<VERSION> and pushes it. GitHub Actions (.github/workflows/release.yml)
# then builds the Mac, Windows and Android apps and publishes them as one release, which every installed copy
# picks up through its update check. Write RELEASE_NOTES.md first.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(tr -d '[:space:]' < VERSION)
[[ -z "$(git status --porcelain)" ]] || { echo "Commit your changes first."; exit 1; }
[[ -f RELEASE_NOTES.md ]] || { echo "Write RELEASE_NOTES.md first."; exit 1; }
git push -q origin main
git tag "v$VERSION"
git push -q origin "v$VERSION"
echo "Tagged v$VERSION. Follow the build: gh run watch \$(gh run list -w Release -L 1 --json databaseId -q '.[0].databaseId')"
