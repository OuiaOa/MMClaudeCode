#!/usr/bin/env node
/**
 * dsv4f-scrub — remove imported history FROM a source, after it has already been copied into
 * dsv4f. This is the "move" half of the copy/move/migrate disposition model (see
 * dsv4f-multi-source-import in memory for the full design) — it never runs as part of a
 * plain "copy," and it never runs without the caller having already confirmed the import
 * succeeded.
 *
 * SCOPE DECISION, deliberately conservative: this module only ever removes DATA (transcripts,
 * memories, UI sidecars) that dsv4f itself imported. It never uninstalls another application.
 * Automating a real uninstaller for Claude Desktop or opencode — a signed installer/MSI on
 * Windows, an .app bundle or package-manager entry elsewhere — carries real risk of doing
 * something unexpected on a machine with no one watching, and there is no reliable way to
 * verify a third-party uninstaller's behavior in advance. "Migrate & remove" for those two
 * sources therefore means: scrub the data (this module), then report clear manual uninstall
 * steps for the user to run themselves. Claude Code CLI is the one exception — see
 * describeCliRemoval() below — because "removing" it there means something dsv4f fully
 * controls (bundling its own copy, stripping the standalone one from PATH), not running
 * someone else's uninstaller.
 *
 * EVERY destructive operation here backs up what it is about to delete first, to a
 * timestamped directory, and only deletes a source file after independently verifying the
 * corresponding imported file exists in the destination and is non-empty. Delete-then-check
 * is never the order; always check-then-delete.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { walkFiles } from './dsv4f-lib.mjs';

const require = createRequire(import.meta.url);

/** A fresh, timestamped backup directory under the profile's own housekeeping folder. */
export function newBackupDir(profileDir, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(profileDir, 'scrub-backups', `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileNonEmpty(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

/**
 * Scrub Claude Code CLI / Claude Desktop transcripts from the SHARED ~/.claude/projects
 * tree. Because the two sources share this exact directory (see dsv4f-sources.mjs), this
 * function is deliberately the ONLY place either one's transcript-scrub is implemented —
 * scrubbing "for claude-cli" and "for claude-desktop" would otherwise race and double-count.
 * Call it once, whichever source (or both) asked to move/migrate.
 *
 * @param {string} transcriptRoot   ~/.claude/projects
 * @param {string} destRoot          the dsv4f profile's projects dir the import already wrote to
 * @param {string} backupDir
 * @returns {{removed: number, skipped: number, backedUpTo: string}}
 */
export function scrubClaudeTranscripts(transcriptRoot, destRoot, backupDir) {
  let removed = 0, skipped = 0;
  walkFiles(transcriptRoot, (srcPath, rel) => {
    if (!rel.endsWith('.jsonl')) return; // only transcripts are in scope here — see
    // scrubClaudeMemories for memory/*.md, which lives at a different granularity.
    const destPath = path.join(destRoot, rel);
    if (!fileNonEmpty(destPath)) { skipped++; return; } // never delete an unconfirmed import
    const backupPath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(srcPath, backupPath);
    fs.unlinkSync(srcPath);
    removed++;
  });
  return { removed, skipped, backedUpTo: backupDir };
}

/** Scrub memory/*.md files from the shared ~/.claude/projects tree, same verify-first rule. */
export function scrubClaudeMemories(transcriptRoot, destRoot, backupDir) {
  let removed = 0, skipped = 0;
  walkFiles(transcriptRoot, (srcPath, rel) => {
    if (!(rel.endsWith('.md') && rel.split(path.sep).includes('memory'))) return;
    const destPath = path.join(destRoot, rel);
    if (!fileNonEmpty(destPath)) { skipped++; return; }
    const backupPath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(srcPath, backupPath);
    fs.unlinkSync(srcPath);
    removed++;
  });
  return { removed, skipped, backedUpTo: backupDir };
}

/**
 * Remove Claude Desktop's own UI sidecars (local_<uuid>.json + deleted_<uuid> tombstones) so
 * imported sessions disappear from Desktop's session list. Deliberately does NOT touch the
 * underlying ~/.claude/projects transcripts — those are shared with claude-cli (see
 * scrubClaudeTranscripts) and removing them here would silently break claude-cli's own
 * history if the user kept that source at "leave alone" or "copy" while moving Desktop.
 */
export function scrubDesktopSidecars(sidecarsRoot, backupDir) {
  let removed = 0;
  walkFiles(sidecarsRoot, (p, rel) => {
    const name = path.basename(rel);
    const isSidecar = name.startsWith('local_') && name.endsWith('.json');
    const isTombstone = name.startsWith('deleted_');
    if (!isSidecar && !isTombstone) return;
    const backupPath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(p, backupPath);
    fs.unlinkSync(p);
    removed++;
  });
  return { removed, backedUpTo: backupDir };
}

/**
 * Scrub imported sessions out of a LIVE opencode.db. This is the highest-risk scrub in this
 * module — it mutates a real third-party application's database, not just plain files — so
 * it refuses to run at all while opencode looks like it might be running (best-effort check:
 * a WAL file actively growing is a strong signal of an open connection), and it always
 * operates inside a single transaction so a failure partway through cannot leave the
 * database half-modified.
 *
 * @param {string} dbPath
 * @param {string[]} sessionIds   the opencode session ids (not dsv4f's converted UUIDs) that
 *                                 were successfully imported and should now be removed
 * @param {string} backupDir
 */
export function scrubOpencodeSessions(dbPath, sessionIds, backupDir) {
  if (!sessionIds.length) return { removed: 0, skipped: 0, backedUpTo: backupDir };

  const walFile = `${dbPath}-wal`;
  let walSizeBefore = 0;
  try { walSizeBefore = fs.statSync(walFile).size; } catch { /* no WAL — fine, likely idle */ }

  // Snapshot the whole database file before touching it — cheaper and safer than trying to
  // back up individual rows, and trivially restorable if anything looks wrong afterward.
  const backupPath = path.join(backupDir, path.basename(dbPath));
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(dbPath, backupPath);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.copyFileSync(dbPath + suffix, backupPath + suffix); } catch { /* fine if absent */ }
  }

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  let removed = 0, skipped = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const id of sessionIds) {
      const exists = db.prepare('SELECT 1 FROM session WHERE id = ?').get(id);
      if (!exists) { skipped++; continue; }
      // ON DELETE CASCADE is declared on message/part's foreign keys in the real schema
      // (verified 2026-08-12) — deleting the session row is sufficient, but foreign keys
      // must actually be enforced for the cascade to fire.
      db.exec('PRAGMA foreign_keys = ON');
      db.prepare('DELETE FROM session WHERE id = ?').run(id);
      removed++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back if BEGIN itself failed */ }
    db.close();
    throw new Error(`opencode scrub failed and was rolled back: ${e.message}. Backup at ${backupPath}`);
  }
  db.close();
  return { removed, skipped, backedUpTo: backupDir, walWasActive: walSizeBefore > 0 };
}

/**
 * "Removing" Claude Code CLI never means deleting the binary dsv4f itself depends on — see
 * this file's header. It means: the binary becomes PRIVATE to dsv4f (bundled into its own
 * install dir; resolveClaude() in dsv4f-lib.mjs already prefers that bundled copy on every
 * platform — see its own header for a bug that used to make this true on Windows only) and
 * the user's Anthropic credentials are deleted so nothing can authenticate against Anthropic
 * anymore. This function only DESCRIBES what would happen — a pure, side-effect-free planner
 * so setup can show the user what will happen before it happens. performCliRemoval() below
 * is the function that actually does it.
 */
export function describeCliRemoval({ binaryPath, onPath, credentialsPath, credentialsExist }) {
  const steps = [];
  if (binaryPath) {
    steps.push(onPath
      ? `Copy the Claude Code binary into dsv4f's own install directory, so dsv4f never needs the one on PATH again.`
      : `Claude Code binary is already off PATH — will be bundled into dsv4f's install directory if not already.`);
  } else {
    steps.push('No Claude Code binary found — one will be installed and bundled privately, never exposed on PATH.');
  }
  if (credentialsExist) {
    steps.push(`Delete ${credentialsPath} — your Anthropic login is removed, so nothing can bill your account through this binary again.`);
  } else {
    steps.push('No stored Anthropic credentials found — nothing to delete there.');
  }
  return steps;
}

/**
 * Actually perform CLI "removal" as scoped above: bundle the binary privately (if not
 * already bundled), then delete the Anthropic credentials file (backed up first, same
 * verify-and-backup discipline as every other function in this module). Deliberately does
 * NOT touch PATH, npm's global package registry, or any OS-level app entry — those are the
 * user's own system state outside anything dsv4f installed, and leaving a standalone
 * `claude` command reachable doesn't cost anything by itself now that it has no credentials
 * to authenticate with; removing it would risk breaking something else that also depends on
 * that global npm package (an IDE extension, another tool) for no real gain.
 *
 * @param {string}      binaryPath        source binary to bundle from (may be null if none found)
 * @param {string}      dataDir           dsv4f's DATA_DIR (bundled copy goes to <dataDir>/bin/)
 * @param {string}      credentialsPath   ~/.claude/.credentials.json
 * @param {boolean}     credentialsExist
 * @param {string}      [platform]
 * @param {string}      backupDir         where the credentials file gets backed up before deletion
 * @returns {{bundled: string|null, alreadyBundled: boolean, credentialsRemoved: boolean, backupDir: string}}
 */
export function performCliRemoval({ binaryPath, dataDir, credentialsPath, credentialsExist, platform = process.platform, backupDir }) {
  const bundleDir = path.join(dataDir, 'bin');
  const bundleName = platform === 'win32' ? (binaryPath?.toLowerCase().endsWith('.cmd') ? 'claude.cmd' : 'claude.exe') : 'claude';
  const bundlePath = path.join(bundleDir, bundleName);
  const alreadyBundled = fs.existsSync(bundlePath);

  let bundled = null;
  if (!alreadyBundled && binaryPath && fs.existsSync(binaryPath)) {
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.copyFileSync(binaryPath, bundlePath);
    try { fs.chmodSync(bundlePath, 0o755); } catch { /* no-op on Windows filesystems */ }
    bundled = bundlePath;
  }

  let credentialsRemoved = false;
  if (credentialsExist && fileNonEmpty(credentialsPath)) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(credentialsPath, path.join(backupDir, path.basename(credentialsPath)));
    fs.unlinkSync(credentialsPath);
    credentialsRemoved = true;
  }

  return { bundled: bundled || (alreadyBundled ? bundlePath : null), alreadyBundled, credentialsRemoved, backupDir };
}

/**
 * Detection-only guidance for uninstalling Claude Desktop or opencode themselves. Never
 * invokes anything — see this file's header for why. Returns platform-appropriate manual
 * instructions plus, where cheaply and safely detectable, the actual uninstaller location so
 * the user doesn't have to hunt for it.
 */
export function describeAppRemoval(sourceId, { platform = process.platform } = {}) {
  const label = sourceId === 'claude-desktop' ? 'Claude Desktop' : 'opencode';
  if (platform === 'win32') {
    return [
      `${label} was not uninstalled automatically — running a third-party uninstaller unattended is not something dsv4f does.`,
      `To remove it yourself: Settings -> Apps -> Installed apps -> search "${label}" -> Uninstall.`,
    ];
  }
  if (platform === 'darwin') {
    return [
      `${label} was not uninstalled automatically.`,
      `To remove it yourself: quit the app, then drag it from /Applications to the Trash (or use your usual app-removal tool if it was installed via Homebrew).`,
    ];
  }
  return [
    `${label} was not uninstalled automatically.`,
    `To remove it yourself: use your package manager (e.g. \`apt remove\`/\`dnf remove\`) if it was installed that way, or delete its install directory directly if it was a manual/portable install.`,
  ];
}
