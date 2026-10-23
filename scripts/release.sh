#!/bin/zsh
# Publishes the current VERSION as a GitHub release with the DMG attached.
# The app's update checker reads the latest release, so publishing is what notifies users.
#
#   scripts/release.sh              # release VERSION with notes from RELEASE_NOTES.md
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(tr -d '[:space:]' < VERSION)
[[ -z "$(git status --porcelain)" ]] || { echo "Commit your changes first."; exit 1; }
scripts/make_dmg.sh
NOTES=RELEASE_NOTES.md
[[ -f $NOTES ]] || { echo "Write $NOTES first."; exit 1; }
git tag -f "v$VERSION"
git push -q origin main "v$VERSION" --force
gh release create "v$VERSION" "MK-PDF-$VERSION.dmg" --title "MK PDF $VERSION" --notes-file "$NOTES" --latest
