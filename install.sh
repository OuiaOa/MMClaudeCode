#!/usr/bin/env bash
# claude-dsv4f installer — Linux / macOS / WSL
#
# Detects Node, npm, and Claude Code. If Claude Code is missing, attempts to install it
# via `npm install -g @anthropic-ai/claude-code` (only when npm is on PATH and the user
# didn't pass --no-auto-install). If Node/npm are missing entirely, fails with an
# actionable, OS-specific error rather than trying to bootstrap a toolchain.
#
# Flags:
#   --no-auto-install    do NOT auto-install Claude Code even if missing
#   --bundle             copy Claude Code's binary into the dsv4f install, so the
#                        resulting setup is self-contained and the resolver prefers
#                        the bundled copy. Has no effect if Claude Code isn't on PATH.
#   --update             re-copy files even if the destination already exists
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DSV4F_HOME:-$HOME/.local/share/claude-dsv4f}"
BIN="$HOME/.local/bin"

AUTO_INSTALL=1
BUNDLE=0
UPDATE=0
for a in "$@"; do
  case "$a" in
    --no-auto-install) AUTO_INSTALL=0 ;;
    --bundle)          BUNDLE=1 ;;
    --update)          UPDATE=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done

# -------------------------------------------------------------- Node check (hard)
command -v node >/dev/null || { echo "Node.js v20+ is required. Install from:"; echo "  https://nodejs.org/  (or use your package manager)"; exit 1; }
node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if (( node_major < 20 )); then
  echo "Node $node_major detected — claude-dsv4f needs v20 or newer. Please upgrade: https://nodejs.org/"; exit 1
fi

# ------------------------------------------------------ Claude Code detection
claude_bin="$(command -v claude || true)"
if [[ -z "$claude_bin" && "$AUTO_INSTALL" -eq 1 ]]; then
  if command -v npm >/dev/null; then
    echo "Claude Code CLI not found on PATH — attempting install via npm..."
    if npm install -g @anthropic-ai/claude-code 2>&1 | tail -5; then
      echo "Claude Code installed."
      # Refresh PATH-aware hash for this shell
      hash -r 2>/dev/null || true
      claude_bin="$(command -v claude || true)"
    else
      echo "  npm install failed — falling through to manual instructions."
    fi
  else
    echo "  npm not found either — install Node.js from https://nodejs.org/, then run:"
    echo "    npm install -g @anthropic-ai/claude-code"
  fi
fi

if [[ -z "$claude_bin" ]]; then
  echo ""
  echo "Claude Code CLI is required. Install from https://claude.com/code, then re-run."
  echo "  (If you've installed it elsewhere, re-run with the full path on PATH.)"
  exit 1
fi

# ------------------------------------------------------------- copy files
mkdir -p "$DEST" "$BIN"
if [[ "$SRC" != "$DEST" || "$UPDATE" -eq 1 ]]; then
  cp -r "$SRC"/shim.mjs "$SRC"/probe.mjs "$SRC"/statusline.sh "$SRC"/test-shim.mjs \
        "$SRC"/config.default.json "$SRC"/bin "$DEST"/
  [[ -d "$SRC/e2e" ]] && cp -r "$SRC/e2e" "$DEST"/ || true
fi
chmod +x "$DEST"/bin/* "$DEST"/statusline.sh 2>/dev/null || true

# --------------------------------------------- optional: bundle Claude Code
# Copies the claude binary into the dsv4f install so the resolver can prefer it.
# This makes the dsv4f install self-contained — PATH becomes optional.
if [[ "$BUNDLE" -eq 1 ]]; then
  bundled="$DEST/bin/claude"
  if cp "$claude_bin" "$bundled" 2>/dev/null; then
    chmod +x "$bundled"
    echo "Bundled Claude Code → $bundled (resolver will prefer this copy)."
  else
    echo "  WARNING: could not bundle '$claude_bin' into $DEST/bin/claude (continuing anyway)."
  fi
fi

# ------------------------------------------------------------- PATH shims
for n in dsv4f claude-dsv4f dsv4f-usage dsv4f-import; do rm -f "$BIN/$n"; done
ln -s "$DEST/bin/dsv4f.mjs"      "$BIN/dsv4f"
ln -s "$DEST/bin/dsv4f.mjs"      "$BIN/claude-dsv4f"
ln -s "$DEST/bin/dsv4f-usage"    "$BIN/dsv4f-usage"
ln -s "$DEST/bin/dsv4f-import"   "$BIN/dsv4f-import"

echo ""
echo "Installed to $DEST"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "NOTE: add $BIN to your PATH (or open a new terminal)";; esac
echo "Next:  dsv4f setup"