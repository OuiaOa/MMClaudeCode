#!/usr/bin/env bash
# End-to-end test of the real installed claude-dsv4f: a real Claude Code session, against the
# real DeepSeek endpoint, with real screenshots routed through the real vision model.
#
# Each scenario plants a defect that is visible ONLY in the render — the numbers that collide
# live in separate source files and neither is wrong alone. So the agent cannot answer from the
# source, and the vision path is genuinely under test rather than incidentally exercised.
#
# Usage: e2e/run-e2e.sh [game|web|tools|all]

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${DSV4F_CONFIG_DIR:-$HOME/.config/claude-dsv4f}"
DATA_DIR="${DSV4F_DATA_DIR:-$HOME/.local/share/claude-dsv4f}"
LEDGER="$DATA_DIR/usage.jsonl"
WORK="$DIR/tmp"
mkdir -p "$WORK"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; [[ -n "${2:-}" ]] && printf '      %s\n' "$2"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# grep -c prints "0" AND exits non-zero when nothing matches, so a bare `|| echo 0` emits
# two lines and every arithmetic comparison downstream blows up.
count_rows() { local n; n=$(grep -c "$1" "$LEDGER" 2>/dev/null | head -1); echo "${n:-0}"; }
vision_calls() { count_rows '"provider":"deepinfra"'; }
ds_requests()  { count_rows '"provider":"deepseek"'; }

run_claude() {           # run_claude <cwd> <prompt-file> -> stdout captured to $OUT
  local cwd="$1" promptfile="$2"
  ( cd "$cwd" && CLAUDE_CONFIG_DIR="$HOME/.claude-dsv4f" \
      timeout 900 claude -p "$(cat "$promptfile")" \
        --settings "$HOME/.claude-dsv4f/settings.json" 2>&1 )
}

# --------------------------------------------------------------------- scenario: game
scenario_game() {
  head_ "SCENARIO: game build — HUD placement visible only in the render"
  local proj="$WORK/voxel-skirmish"
  node "$DIR/gen-project.mjs" game "$proj" | sed 's/^/  /'
  cp "$DIR/scenes/game-hud.png" "$proj/screenshot.png"

  local v0 d0; v0=$(vision_calls); d0=$(ds_requests)
  cat > "$WORK/game-prompt.txt" <<EOF
This is the Voxel Skirmish repo. A playtester reported that the HUD looks wrong, and attached
screenshot.png from the running game.

VISION: the exact pixel bounds and z-order of every HUD element, and any elements that overlap.

Read screenshot.png, work out which two HUD elements collide, then find and fix the layout
constants in the source so they no longer overlap. Keep the health bar's width unchanged; move
or resize whatever is appropriate. Do not use bash image tools.

Finish with a single line: VERDICT: <element A> overlaps <element B>
EOF
  local out; out=$(run_claude "$proj" "$WORK/game-prompt.txt")
  echo "$out" | tail -4 | sed 's/^/  | /'

  local v1; v1=$(vision_calls)
  [[ "$v1" -gt "$v0" ]] && ok "vision model was invoked ($((v1-v0)) call)" || bad "no vision call recorded" "the agent never saw the image"
  [[ "$(ds_requests)" -gt "$d0" ]] && ok "DeepSeek did the reasoning" || bad "no DeepSeek requests"

  grep -qi "minimap" <<<"$out" && ok "identified the minimap" || bad "did not mention the minimap"
  grep -qiE "health|hp" <<<"$out" && ok "identified the health bar" || bad "did not mention the health bar"
  grep -qiE "overlap|collid|on top of|covers|obscur" <<<"$out" && ok "described the collision" || bad "did not describe a collision"

  # The fix must land in the source, not just in prose.
  if grep -qE "healthBar:\s*\{[^}]*(x:\s*(?!620)[0-9]+|y:\s*(?!24)[0-9]+)" -P "$proj/src/ui/hud-layout.js" 2>/dev/null \
     || ! grep -q "x: 620, y: 24, width: 320" "$proj/src/ui/hud-layout.js" 2>/dev/null \
     || ! grep -q "x: 700, y: 16, width: 240" "$proj/src/ui/minimap.js" 2>/dev/null; then
    ok "edited the layout constants in source"
  else
    bad "source constants unchanged" "$(grep -h 'healthBar\|MINIMAP =' "$proj/src/ui/hud-layout.js" "$proj/src/ui/minimap.js" | tr '\n' ' ')"
  fi
}

# ---------------------------------------------------------------------- scenario: web
scenario_web() {
  head_ "SCENARIO: webpage design — which card's CTA is broken"
  local proj="$WORK/landing"
  node "$DIR/gen-project.mjs" web "$proj" | sed 's/^/  /'
  cp "$DIR/scenes/pricing-page.png" "$proj/screenshot.png"

  local v0; v0=$(vision_calls)
  cat > "$WORK/web-prompt.txt" <<EOF
This is the landing-page repo. screenshot.png is the rendered pricing section.

VISION: for each plan card, the card's bounds and its button's bounds, whether any button
extends past its card, and whether any button label is cut off.

Read screenshot.png. Exactly one of the two plan cards has a broken call-to-action button.
Identify which one, then fix the CSS so the button fits inside its card. Do not use bash
image tools.

Finish with a single line: VERDICT: <plan name> CTA overflows
EOF
  local out; out=$(run_claude "$proj" "$WORK/web-prompt.txt")
  echo "$out" | tail -4 | sed 's/^/  | /'

  [[ "$(vision_calls)" -gt "$v0" ]] && ok "vision model was invoked" || bad "no vision call recorded"
  grep -qi "starter" <<<"$out" && ok "identified the Starter card as broken" || bad "did not identify Starter"
  grep -qiE "overflow|clipped|cut off|too wide|extends" <<<"$out" && ok "described the overflow" || bad "did not describe overflow"
  grep -qi "verdict:.*pro" <<<"$out" && bad "wrongly blamed the Pro card" || ok "did not blame the correct Pro card"

  if ! grep -q "width: 380px" "$proj/src/components/pricing/cta.css" 2>/dev/null; then
    ok "narrowed the CTA in cta.css"
  else
    bad "cta.css still has width: 380px"
  fi
}

# -------------------------------------------------------------------- scenario: tools
scenario_tools() {
  head_ "SCENARIO: tool coverage across a large tree"
  local proj="$WORK/voxel-skirmish-tools"
  node "$DIR/gen-project.mjs" game "$proj" | sed 's/^/  /'
  cat > "$WORK/tools-prompt.txt" <<EOF
In this repo, without using any image tools:
1. Count the .js files under src/ and state the number.
2. Find every file containing the identifier PLAYER_SPEED and list the paths.
3. Read src/entities/player.js and report the spawn coordinates.
4. Create a file NOTES.md containing exactly one line: audit complete
5. Change PLAYER_SPEED to 4.0 in place.
6. Run: ls src/systems | wc -l   and report the number it prints.

Finish with: DONE <js file count> <ls count>
EOF
  local out; out=$(run_claude "$proj" "$WORK/tools-prompt.txt")
  echo "$out" | tail -3 | sed 's/^/  | /'

  local jsCount; jsCount=$(find "$proj/src" -name '*.js' | wc -l)
  grep -q "$jsCount" <<<"$out" && ok "Glob/find: counted $jsCount js files correctly" || bad "wrong or missing js count" "expected $jsCount"
  grep -qi "player.js" <<<"$out" && ok "Grep: located PLAYER_SPEED" || bad "did not locate PLAYER_SPEED"
  grep -qE "120" <<<"$out" && ok "Read: reported spawn coordinates" || bad "did not report spawn x=120"
  [[ -f "$proj/NOTES.md" ]] && grep -q "audit complete" "$proj/NOTES.md" && ok "Write: created NOTES.md" || bad "NOTES.md missing or wrong"
  grep -q "PLAYER_SPEED = 4.0" "$proj/src/entities/player.js" && ok "Edit: changed PLAYER_SPEED in place" || bad "PLAYER_SPEED not edited"
  grep -q "28" <<<"$out" && ok "Bash: reported ls output (28)" || bad "did not report the ls count"
}

# --------------------------------------------------------------------------- main
printf '\033[1mclaude-dsv4f end-to-end\033[0m\n'
curl -sf -m 3 "http://127.0.0.1:$(node -e 'process.stdout.write(String(process.env.DSV4F_PORT||JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||8788))' "$CONFIG_DIR/config.json")/_dsv4f/health" >/dev/null \
  && echo "  shim: healthy" || { echo "  shim: NOT RESPONDING — aborting"; exit 1; }

case "${1:-all}" in
  game)  scenario_game ;;
  web)   scenario_web ;;
  tools) scenario_tools ;;
  all)   scenario_tools; scenario_game; scenario_web ;;
  *) echo "usage: run-e2e.sh [game|web|tools|all]"; exit 1 ;;
esac

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
