#!/usr/bin/env node
/**
 * mmclaude-setup-sources — execute the per-source import/scrub/remove choices collected by
 * mmclaude-setup.mjs's picker. Kept in its own module (not inline in mmclaude-setup.mjs) so it can
 * be imported and unit-tested directly — mmclaude-setup.mjs itself runs interactive/side-
 * effecting code (key prompts, endpoint probing, systemd installation) at import time, which
 * makes IT unsafe to import from a test.
 *
 * claude-cli and claude-desktop share one import pass (mmclaude-import already walks the whole
 * ~/.claude tree, which both sources point at — see mmclaude-sources.mjs's header) but get
 * INDEPENDENT scrub passes: only claude-cli's disposition may touch the shared transcripts;
 * claude-desktop's own disposition only ever touches its private sidecar files, never the
 * transcripts claude-cli might still want. See mmclaude-scrub.mjs's header for the full
 * reasoning behind that split and for why "remove" never means running a third-party
 * uninstaller unattended.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bold = s => `\x1b[1m${s}\x1b[0m`;
const yel = s => `\x1b[33m${s}\x1b[0m`;

/**
 * @param {object} opts
 * @param {Array}  opts.sources        the `present` subset of detectSources()'s output
 * @param {object} opts.disposition    { [sourceId]: 'leave'|'copy'|'move'|'remove' }
 * @param {string} opts.node           node executable to spawn mmclaude-import with
 * @param {string} opts.ROOT           mmclaude package root (bin/mmclaude-import lives under here)
 * @param {string} opts.PROFILE_DIR    destination mmclaude profile (~/.mmclaude normally)
 * @param {string} opts.DATA_DIR       mmclaude's DATA_DIR (bundled Claude Code binary lands
 *                                     under <DATA_DIR>/bin/ — only used for cliDisp==='remove')
 * @param {object} [opts.importEnv]    extra env vars for the mmclaude-import subprocess (tests
 *                                     use this for MMCLAUDE_PROFILE / --source overrides
 *                                     via env rather than argv, to keep this signature simple)
 * @param {string} [opts.importStdio]  stdio mode for the mmclaude-import subprocess (default
 *                                     'inherit' for real use; tests use 'pipe' to stay quiet)
 * @param {Function} [opts.log]        defaults to console.log — injectable so tests can
 *                                     assert on output without terminal noise
 */
export async function applySourceDispositions({
  sources, disposition, node, ROOT, PROFILE_DIR, DATA_DIR,
  importEnv = {}, importStdio = 'inherit', log = console.log, errorLog = console.error,
}) {
  const cli = sources.find(s => s.id === 'claude-cli');
  const desktop = sources.find(s => s.id === 'claude-desktop');
  const opencode = sources.find(s => s.id === 'opencode');
  const cliDisp = disposition['claude-cli'] || 'leave';
  const desktopDisp = disposition['claude-desktop'] || 'leave';
  const opencodeDisp = disposition['opencode'] || 'leave';
  const destProjectsDir = path.join(PROFILE_DIR, 'projects');
  const summary = { cli: null, desktop: null, opencode: null };

  // ---- claude-cli / claude-desktop: one shared import covers both ----
  if (cliDisp !== 'leave' || desktopDisp !== 'leave') {
    log(bold('\nImporting Claude Code / Desktop history...'));
    const r = spawnSync(node, [path.join(ROOT, 'bin', 'mmclaude-import'), '--all'],
      { stdio: importStdio, env: { ...process.env, ...importEnv } });
    if (r.status !== 0) errorLog(yel(`Import returned ${r.status}; you can retry with: mmclaude-import --force`));
    summary.cliImportStatus = r.status;
  }

  if (['move', 'remove'].includes(cliDisp) && cli) {
    log(bold("\nClearing imported history from Claude Code CLI's ~/.claude..."));
    const { newBackupDir, scrubClaudeTranscripts, scrubClaudeMemories } = await import('./mmclaude-scrub.mjs');
    const backupDir = newBackupDir(PROFILE_DIR, 'claude-cli');
    const t = scrubClaudeTranscripts(cli.paths.transcriptRoot, destProjectsDir, backupDir);
    const m = scrubClaudeMemories(cli.paths.transcriptRoot, destProjectsDir, backupDir);
    log(`  removed ${t.removed} transcript(s), ${m.removed} memory file(s)` +
      ((t.skipped + m.skipped) ? ` (${t.skipped + m.skipped} skipped — not confirmed imported, left in place)` : ''));
    log(`  backup: ${backupDir}`);
    summary.cli = { removed: t.removed + m.removed, skipped: t.skipped + m.skipped, backupDir };
  }
  if (['move', 'remove'].includes(desktopDisp) && desktop) {
    log(bold("\nClearing imported sessions from Claude Desktop's own list..."));
    const { newBackupDir, scrubDesktopSidecars } = await import('./mmclaude-scrub.mjs');
    const backupDir = newBackupDir(PROFILE_DIR, 'claude-desktop');
    const r = scrubDesktopSidecars(desktop.paths.sessionSidecars, backupDir);
    log(`  removed ${r.removed} sidecar/tombstone file(s)`);
    log(`  backup: ${backupDir}`);
    summary.desktop = { removed: r.removed, backupDir };
  }
  if (cliDisp === 'remove' && cli) {
    log(bold('\nClaude Code CLI — bundling privately and dropping Anthropic credentials...'));
    const { newBackupDir, performCliRemoval } = await import('./mmclaude-scrub.mjs');
    const backupDir = newBackupDir(PROFILE_DIR, 'claude-cli-credentials');
    const r = performCliRemoval({
      binaryPath: cli.binary, dataDir: DATA_DIR,
      credentialsPath: cli.paths.credentials, credentialsExist: cli.hasCredentials,
      backupDir,
    });
    if (r.alreadyBundled) log(`  binary already bundled at ${r.bundled}`);
    else if (r.bundled) log(`  bundled Claude Code -> ${r.bundled}`);
    else log(yel('  no binary was available to bundle — mmclaude will need one on PATH or provisioned separately'));
    if (r.credentialsRemoved) log(`  removed Anthropic credentials (backed up to ${r.backupDir})`);
    else log('  no stored Anthropic credentials to remove');
    summary.cliRemoval = r;
  }
  if (desktopDisp === 'remove' && desktop) {
    log(bold('\nClaude Desktop:'));
    const { describeAppRemoval } = await import('./mmclaude-scrub.mjs');
    for (const step of describeAppRemoval('claude-desktop')) log(`  - ${step}`);
  }

  // ---- opencode ----
  if (opencodeDisp !== 'leave' && opencode) {
    log(bold('\nImporting opencode history...'));
    const conv = await import('./mmclaude-opencode-convert.mjs');
    let db;
    try { db = conv.openDb(opencode.paths.db); }
    catch (e) { errorLog(yel(`  could not open opencode.db: ${e.message}`)); db = null; }
    const importedOpencodeIds = [];
    let converted = 0, failed = 0;
    if (db) {
      const rows = conv.listSessions(opencode.paths.db);
      for (const row of rows) {
        let result;
        try { result = conv.convertSession(db, row.id); }
        catch (e) { failed++; errorLog(yel(`  ${row.id}: ${e.message}`)); continue; }
        if (!result.lines.length) continue; // empty session — nothing to import, nothing to scrub
        conv.writeConvertedSession(PROFILE_DIR, result);
        converted++;
        importedOpencodeIds.push(row.id);
      }
      db.close();
      log(`  imported ${converted} session(s)${failed ? `, ${failed} failed (see above)` : ''}`);
    }
    summary.opencode = { converted, failed, importedIds: importedOpencodeIds };

    if (['move', 'remove'].includes(opencodeDisp) && importedOpencodeIds.length) {
      log(bold('\nClearing imported sessions from opencode...'));
      const { newBackupDir, scrubOpencodeSessions } = await import('./mmclaude-scrub.mjs');
      const backupDir = newBackupDir(PROFILE_DIR, 'opencode');
      try {
        const r = scrubOpencodeSessions(opencode.paths.db, importedOpencodeIds, backupDir);
        log(`  removed ${r.removed} session(s) from opencode.db${r.skipped ? `, ${r.skipped} skipped` : ''}`);
        log(`  backup: ${backupDir}`);
        summary.opencode.scrub = { removed: r.removed, skipped: r.skipped, backupDir };
      } catch (e) {
        errorLog(yel(`  ${e.message}`));
        summary.opencode.scrubError = e.message;
      }
    }
    if (opencodeDisp === 'remove') {
      log(bold('\nopencode:'));
      const { describeAppRemoval } = await import('./mmclaude-scrub.mjs');
      for (const step of describeAppRemoval('opencode')) log(`  - ${step}`);
    }
  }

  return summary;
}
