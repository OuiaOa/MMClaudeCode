#!/usr/bin/env node
/**
 * mmclaude-statusline — cross-platform port of the original statusline.sh.
 *
 * The bash version needed a real POSIX shell + curl, neither guaranteed on Windows — so
 * mmclaude-setup.mjs never wired a statusLine at all there (`WIN ? undefined : {...}`), and every
 * Windows install silently missed the cost/context/burn-rate display under the prompt box.
 * Every mmclaude install already requires Node itself, so a pure-Node implementation removes that
 * platform gap instead of trying to make bash+curl a dependency on Windows.
 *
 * Claude Code's own /cost computes from an embedded price table keyed on model name; a
 * minimax-* id misses that lookup and silently reports $0. So spend comes from the shim's
 * own ledger (GET /_mmclaude/usage) instead. Token counts in the stdin payload are accurate and
 * used as-is.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { configuredPort } from './mmclaude-port-manager.mjs';

const CONFIG_DIR = process.env.MMCLAUDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'mmclaude');
const DATA_DIR = process.env.MMCLAUDE_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'mmclaude');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    return configuredPort({ envVar: 'MMCLAUDE_PORT', dataDir: DATA_DIR, app: 'mmclaude', configPort: cfg.port, defaultPort: 8788 });
  } catch { return configuredPort({ envVar: 'MMCLAUDE_PORT', dataDir: DATA_DIR, app: 'mmclaude', defaultPort: 8788 }); }
}

function readSentinel() {
  try { return fs.readFileSync(path.join(CONFIG_DIR, 'sentinel'), 'utf8').trim(); } catch { return ''; }
}

function fetchUsage(port, sentinel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({
      host: '127.0.0.1', port, path: '/_mmclaude/usage', timeout: 1000,
      headers: sentinel ? { Authorization: `Bearer ${sentinel}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { done(JSON.parse(body)); } catch { done({}); } });
    });
    req.on('timeout', () => { req.destroy(); done({}); });
    req.on('error', () => done({}));
  });
}

const s = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();
const l = await fetchUsage(readPort(), readSentinel());

// Older running shims, or a usage response captured during startup, may expose the raw
// provider balance before the derived `quota` object was added. Derive the same two values
// here so the statusline never degrades to a bare "quota live" when balance.json is valid.
function rawQuota(balance) {
  const rows = Array.isArray(balance?.model_remains) ? balance.model_remains : [];
  const row = rows.find(r => String(r?.model_name || '').toLowerCase() === 'general') || rows[0];
  if (!row) return {};
  const numberOrNull = v => Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    enabled: true,
    remainingPercent: numberOrNull(row.current_interval_remaining_percent),
    weeklyRemainingPercent: numberOrNull(row.current_weekly_remaining_percent),
  };
}

const C = { dim: '\x1b[2m', r: '\x1b[0m', cyan: '\x1b[36m', grn: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', b: '\x1b[1m' };
const parts = [];

// model + effort
const effort = s.effort?.level ?? l.lastEffort ?? '?';
const eColor = effort === 'max' ? C.red : (effort === 'none' || effort === 'low') ? C.dim : C.yel;
parts.push(`${C.cyan}MMClaude${C.r} ${eColor}${effort}${C.r}`);

// context usage
if (s.context_window?.used_percentage != null) {
  const pct = s.context_window.used_percentage;
  const col = pct > 85 ? C.red : pct > 60 ? C.yel : C.dim;
  const used = (s.context_window.total_input_tokens || 0) + (s.context_window.total_output_tokens || 0);
  parts.push(`${col}ctx ${pct.toFixed(0)}%${C.r} ${C.dim}(${(used / 1000).toFixed(0)}k)${C.r}`);
}

// MiniMax Token Plan is quota-based, not a per-token billing API. Show the provider's live
// remaining percentages instead of the local response-token ledger, which is not the plan's
// accounting unit. The full usage command still exposes request-level diagnostics.
const q = { ...rawQuota(l.balance), ...(l.quota || {}) };
if (q.enabled && (q.remainingPercent != null || q.weeklyRemainingPercent != null)) {
  const pct = v => v == null ? '?' : `${Number(v).toFixed(0)}%`;
  const col = v => v != null && Number(v) <= 10 ? C.red : v != null && Number(v) <= 25 ? C.yel : C.grn;
  parts.push(`${col(q.remainingPercent)}5h left ${pct(q.remainingPercent)}${C.r}`);
  parts.push(`${col(q.weeklyRemainingPercent)}week left ${pct(q.weeklyRemainingPercent)}${C.r}`);
} else if (q.paused) {
  parts.push(`${C.yel}quota paused${C.r}`);
} else if (l.balance) {
  parts.push(`${C.dim}quota live${C.r}`);
}

if (!l.requests && !l.balance) parts.push(`${C.red}shim down${C.r}`);

const dir = (s.workspace?.current_dir || '').replace(os.homedir() || '~', '~');
if (dir) parts.push(`${C.dim}${dir}${C.r}`);

process.stdout.write(parts.join(`${C.dim} | ${C.r}`));
