#!/usr/bin/env bash
# claude-dsv4f statusline.
#
# Claude Code's own /cost computes from an embedded price table keyed on model name; a
# deepseek-* id misses that lookup and silently reports $0. So spend comes from the shim's
# ledger instead. Token counts in the stdin payload are accurate and used as-is.

set -uo pipefail

CONFIG_DIR="${DSV4F_CONFIG_DIR:-$HOME/.config/claude-dsv4f}"
stdin_json="$(cat)"

port=8788
if [[ -r "$CONFIG_DIR/config.json" ]]; then
  p="$(node -e 'try{process.stdout.write(String(process.env.DSV4F_PORT||JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port||8788))}catch{process.stdout.write("8788")}' "$CONFIG_DIR/config.json" 2>/dev/null)"
  [[ -n "$p" ]] && port="$p"
fi

sentinel="$(cat "$CONFIG_DIR/sentinel" 2>/dev/null || true)"
live="$(curl -sf -m 1 -H "Authorization: Bearer $sentinel" "http://127.0.0.1:$port/_dsv4f/usage" 2>/dev/null || echo '{}')"

STDIN_JSON="$stdin_json" LIVE_JSON="$live" node <<'NODE'
const s = (() => { try { return JSON.parse(process.env.STDIN_JSON || '{}'); } catch { return {}; } })();
const l = (() => { try { return JSON.parse(process.env.LIVE_JSON || '{}'); } catch { return {}; } })();

const C = { dim: '\x1b[2m', r: '\x1b[0m', cyan: '\x1b[36m', grn: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', b: '\x1b[1m' };
const parts = [];

// model + effort
const effort = s.effort?.level ?? l.lastEffort ?? '?';
const eColor = effort === 'max' ? C.red : (effort === 'none' || effort === 'low') ? C.dim : C.yel;
parts.push(`${C.cyan}DSv4F${C.r} ${eColor}${effort}${C.r}`);

// context usage
if (s.context_window?.used_percentage != null) {
  const pct = s.context_window.used_percentage;
  const col = pct > 85 ? C.red : pct > 60 ? C.yel : C.dim;
  const used = (s.context_window.total_input_tokens || 0) + (s.context_window.total_output_tokens || 0);
  parts.push(`${col}ctx ${pct.toFixed(0)}%${C.r} ${C.dim}(${(used / 1000).toFixed(0)}k)${C.r}`);
}

// spend today vs cap
if (l.todayUsd != null) {
  const cap = l.capUsd || 0;
  const frac = cap > 0 ? l.todayUsd / cap : 0;
  const col = frac > 0.9 ? C.red : frac > 0.6 ? C.yel : C.grn;
  const amt = l.exact === false ? `$${l.todayUsdMin.toFixed(3)}-${l.todayUsd.toFixed(3)}` : `$${l.todayUsd.toFixed(3)}`;
  parts.push(`${col}${amt}${C.r}${cap > 0 ? `${C.dim}/$${cap.toFixed(0)}${C.r}` : ''}`);
}

// burn rate
if (l.burn?.tokensPerMin) {
  parts.push(`${C.dim}${l.burn.tokensPerMin.toLocaleString('en-US')} tok/min · $${l.burn.usdPerHour.toFixed(2)}/hr${C.r}`);
}

// vision spend against its own cap (separate provider, separate credit pool)
if (l.vision?.enabled && l.vision.spentUsd > 0) {
  const vc = l.vision.capUsd || 0;
  const vfrac = vc > 0 ? l.vision.spentUsd / vc : 0;
  const col = vfrac >= 1 ? C.red : vfrac > 0.6 ? C.yel : C.dim;
  parts.push(`${col}img $${l.vision.spentUsd.toFixed(3)}${vc > 0 ? `/$${vc.toFixed(2)}` : ''}${C.r}`);
}

// remaining credit
const bi = l.balance?.balance_infos?.[0];
if (bi) {
  const bal = parseFloat(bi.total_balance);
  const col = l.balance.is_available === false ? C.red : bal < 5 ? C.yel : C.dim;
  parts.push(`${col}bal ${bal.toFixed(2)} ${bi.currency}${C.r}`);
}

if (!l.todayUsd && !bi) parts.push(`${C.red}shim down${C.r}`);

const dir = (s.workspace?.current_dir || '').replace(process.env.HOME || '~', '~');
if (dir) parts.push(`${C.dim}${dir}${C.r}`);

process.stdout.write(parts.join(`${C.dim} | ${C.r}`));
NODE
