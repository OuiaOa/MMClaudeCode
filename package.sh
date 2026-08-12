#!/usr/bin/env bash
# Build a portable archive containing everything needed on another machine.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HOME/claude-dsv4f-$(date -u +%Y%m%d).tar.gz}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/claude-dsv4f"
mkdir -p "$PKG"
cp -r "$SRC"/shim.mjs "$SRC"/probe.mjs "$SRC"/test-shim.mjs \
      "$SRC"/config.default.json "$SRC"/bin "$SRC"/install.sh "$SRC"/install.ps1 "$SRC"/README.md "$PKG"/ 2>/dev/null || true
cp -r "$SRC"/e2e "$PKG"/ 2>/dev/null || true
# never ship secrets or machine state
rm -f "$PKG"/bin/*.orig "$PKG"/usage.jsonl "$PKG"/balance*.json 2>/dev/null || true
tar -czf "$OUT" -C "$TMP" claude-dsv4f
echo "$OUT"
echo "  $(tar -tzf "$OUT" | wc -l) files, $(du -h "$OUT" | cut -f1)"
