#!/usr/bin/env node
/**
 * dsv4f-reroute — point an EXISTING, kept-installed Claude Code CLI at the dsv4f shim, by
 * adding the standard dsv4f env block to that install's OWN settings.json.
 *
 * This is Axis 3 from the multi-source import design ("keep Claude Code CLI installed, but
 * stop paying Anthropic through it"). The technique is PROVEN — built and verified working
 * end-to-end on PC-4D on 2026-08-12 (a real request through the shim with the target's
 * sentinel returned a genuine DeepSeek reply), then deliberately reverted there once the
 * user decided against a full Desktop takeover. The mechanism itself was never in question;
 * only whether to point it at a shared config without being asked. Applied HERE, it always
 * is asked — this only ever runs as an explicit opt-in on a source disposition the user
 * picked as "leave" or "copy" (i.e. they are deliberately keeping the CLI usable).
 *
 * UNLIKE the scrub module, this never deletes anything — it only ADDS an env block to a
 * settings.json, merging with (never replacing) whatever is already there, after backing
 * the original up. Reverting is exactly "restore the backup."
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the standard dsv4f env block — the SAME keys dsv4f-setup.mjs writes into dsv4f's own
 * isolated profile, applied here to someone else's settings.json instead. Keeping this in
 * one place (rather than copy-pasted between dsv4f-setup.mjs and here) means a future change
 * to the isolated profile's env doesn't quietly drift out of sync with the reroute path.
 */
export function buildRerouteEnv({ port, sentinel }) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: sentinel,
    // Per-tier sentinels, not one shared name. The shim maps each back to its logical tier
    // (config `tierSentinels`) and routes opus/fable to V4 Pro while sonnet stays on the ~3x
    // cheaper V4 Flash. Pointing all three at a single sentinel — correct while there was only
    // one upstream model — makes every tier arrive indistinguishable and collapses the split.
    ANTHROPIC_MODEL: 'deepseek-v4-opus',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-sonnet',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-bg',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash-bg',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash-sub',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-v4-opus',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek V4 Pro / Flash',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_TWO_STAGE_CLASSIFIER: '0',
    CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'deepseek-v4-flash-bg',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    API_TIMEOUT_MS: '900000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '900000',
  };
}

/**
 * Build the non-env extras reroute can ALSO carry into a real install — the polish that
 * used to mean "you have to give up shared history with Desktop/opencode to get it" (only
 * the isolated profile got these). Deliberately does NOT include `permissions` — that's the
 * user's real, daily-driver install; silently changing how often it prompts them is a much
 * bigger behavioral call than "which model backend to use", and unlike env vars it isn't
 * reversible-by-inspection if they don't notice. Leave their own permission choice alone.
 *
 * denyListSrc is the dsv4f install's own SHIPPED copy (ROOT/deny-list.sh) — reused directly
 * rather than copying it a second time into yet another location; it's already a stable
 * path dsv4f itself manages, and only makes sense to wire up as a hook on non-Windows (it's
 * a bash script — no POSIX shell guaranteed on Windows, same reasoning as statusline.sh's
 * old platform gap that dsv4f-statusline.mjs replaced).
 */
export function buildRerouteExtras({ rootDir, platform = process.platform }) {
  const extras = {
    statusLine: { type: 'command', command: `node "${path.join(rootDir, 'bin', 'dsv4f-statusline.mjs')}"`, refreshInterval: 10 },
    effortLevel: 'high',
    skipWebFetchPreflight: true,
  };
  const denyListSrc = path.join(rootDir, 'deny-list.sh');
  if (platform !== 'win32' && fs.existsSync(denyListSrc)) extras.denyListSrc = denyListSrc;
  return extras;
}

/**
 * Apply the reroute to a settings.json, backing up the original first (or noting there was
 * nothing to back up, if the file didn't exist yet). Merges `env` key-by-key and each extras
 * top-level key individually — never touches anything the target already has a value for
 * (so a user's own deliberate customization always survives a reroute, consistent with how
 * dsv4f-setup.mjs treats its own settings.json), and never overwrites an env var the target
 * file already set to something else.
 *
 * @param {string} settingsPath
 * @param {object} envBlock       from buildRerouteEnv()
 * @param {string} backupDir
 * @param {object} [extras]       from buildRerouteExtras() — statusLine/effortLevel/etc, and
 *                                 optionally denyListSrc to wire up the PreToolUse hook
 * @returns {{applied: boolean, added: string[], backupPath: string|null}}
 */
export function applyCliReroute(settingsPath, envBlock, backupDir, extras = {}) {
  let live = {};
  let hadExisting = false;
  if (fs.existsSync(settingsPath)) {
    hadExisting = true;
    try { live = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '')); }
    catch (e) { throw new Error(`${settingsPath} is not valid JSON — refusing to touch it: ${e.message}`); }
  }

  let backupPath = null;
  if (hadExisting) {
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, path.basename(settingsPath));
    fs.copyFileSync(settingsPath, backupPath);
  }

  live.env ??= {};
  const added = [];
  for (const [k, v] of Object.entries(envBlock)) {
    if (!(k in live.env)) { live.env[k] = v; added.push(k); }
  }

  const { denyListSrc, ...topLevelExtras } = extras;
  for (const [k, v] of Object.entries(topLevelExtras)) {
    if (!(k in live)) { live[k] = v; added.push(k); }
  }
  // hooks.PreToolUse is an array — a plain "add if key missing" check would silently skip
  // adding our entry to an ALREADY-populated array (the user's own hook, or a leftover from
  // an earlier reroute). Dedup by command string instead, same as dsv4f-setup.mjs's own
  // isolated-profile logic, so re-running reroute never duplicates the hook.
  if (denyListSrc) {
    live.hooks ??= {};
    live.hooks.PreToolUse ??= [];
    const already = live.hooks.PreToolUse.some(h =>
      Array.isArray(h?.hooks) && h.hooks.some(hh => String(hh?.command || '').includes('deny-list.sh')));
    if (!already) {
      live.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${denyListSrc}`, timeout: 5 }] });
      added.push('hooks.PreToolUse[deny-list]');
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(live, null, 2) + '\n');
  try { fs.chmodSync(settingsPath, 0o600); } catch { /* Windows */ } // now embeds the sentinel

  return { applied: added.length > 0, added, backupPath };
}

/** Reverse a reroute by restoring the exact backup applyCliReroute made. */
export function revertCliReroute(settingsPath, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath} — cannot safely revert.`);
  }
  fs.copyFileSync(backupPath, settingsPath);
}
