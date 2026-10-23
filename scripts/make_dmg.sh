#!/bin/zsh
# Builds MK PDF.app (Apple Silicon + Intel) and packs it into MK-PDF-<version>.dmg with an Applications shortcut.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(tr -d '[:space:]' < VERSION)
UNIVERSAL=${UNIVERSAL:-1} ./build_app.sh
STAGE=$(mktemp -d)/MK\ PDF
mkdir -p "$STAGE"
cp -R "MK PDF.app" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="MK-PDF-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "MK PDF $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
echo "Built $(pwd)/$DMG"
