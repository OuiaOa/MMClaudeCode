#!/usr/bin/env bash
# claude-dsv4f installer — Linux / macOS / WSL
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DSV4F_HOME:-$HOME/.local/share/claude-dsv4f}"
BIN="$HOME/.local/bin"

command -v node >/dev/null || { echo "node is required (v20+)"; exit 1; }
command -v claude >/dev/null || echo "WARNING: 'claude' not on PATH — install Claude Code first."

mkdir -p "$DEST" "$BIN"
if [[ "$SRC" != "$DEST" ]]; then
  cp -r "$SRC"/shim.mjs "$SRC"/probe.mjs "$SRC"/statusline.sh "$SRC"/test-shim.mjs \
        "$SRC"/config.default.json "$SRC"/bin "$DEST"/
  [[ -d "$SRC/e2e" ]] && cp -r "$SRC/e2e" "$DEST"/ || true
fi
chmod +x "$DEST"/bin/* "$DEST"/statusline.sh 2>/dev/null || true

for n in dsv4f claude-dsv4f dsv4f-usage dsv4f-import; do rm -f "$BIN/$n"; done
ln -s "$DEST/bin/dsv4f.mjs"      "$BIN/dsv4f"
ln -s "$DEST/bin/dsv4f.mjs"      "$BIN/claude-dsv4f"   # alias; `claude-dsv4f run` also works
ln -s "$DEST/bin/dsv4f-usage"    "$BIN/dsv4f-usage"
ln -s "$DEST/bin/dsv4f-import"   "$BIN/dsv4f-import"

echo "Installed to $DEST"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "NOTE: add $BIN to your PATH";; esac
echo "Next:  dsv4f setup"
