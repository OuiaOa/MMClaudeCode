#!/usr/bin/env bash
# dsv4shim installer — macOS GUI wrapper
#
# Double-clickable in Finder. Just exec's install.sh with whatever flags were passed.
# Opens Terminal automatically; runs in the user's home directory so relative paths in
# the unpacked archive resolve correctly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HOME"
exec /usr/bin/env bash "$SCRIPT_DIR/install.sh" "$@"