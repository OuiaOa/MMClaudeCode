#!/usr/bin/env node
/**
 * dsv4f-opencode-convert — convert an opencode session (SQLite: session/message/part
 * tables) into a Claude Code-shaped .jsonl transcript, so it can sit in
 * ~/.claude-dsv4f/projects/<project>/<session>.jsonl and be resumed the normal way.
 *
 * opencode's real schema (captured live from an actual install on PC-4D, 10.147.18.245,
 * 2026-08-12 — re-verify before trusting this if much time has passed, opencode moves fast):
 *   session(id, project_id, title, directory, agent, model, time_created, ...)
 *   message(id, session_id, time_created, data JSON)
 *     data: {role, time, agent, model, parentID, cost, tokens:{...}, finish}
 *   part(id, message_id, session_id, time_created, data JSON)
 *     data.type one of:
 *       text        {type:"text", text}
 *       reasoning   {type:"reasoning", text}            -- DROPPED, see below
 *       tool        {type:"tool", tool, callID, state:{status, input, output}}
 *       step-start  {type:"step-start"}                 -- structural, DROPPED
 *       step-finish {type:"step-finish", tokens, cost}   -- structural, DROPPED (but its
 *                                                            tokens feed the usage field)
 *     Only these five types have been observed on the one real install checked. An unknown
 *     type is NOT silently dropped (that could hide real content) — it degrades to a visible
 *     text placeholder instead, matching dsv4f-import's own failure philosophy elsewhere.
 *
 * Mapping decisions:
 *   - `reasoning` parts are dropped, matching dsv4f-import's existing handling of Anthropic
 *     `thinking` blocks (stripped on the way in, since the target model can't validate
 *     Anthropic's cryptographic signature on them anyway — opencode's reasoning text has no
 *     such signature to begin with, so there's nothing valid to carry over).
 *   - A `tool` part becomes a `tool_use` content block on its assistant message PLUS a
 *     synthetic follow-up user-role message carrying the matching `tool_result` — this
 *     mirrors how Claude Code's own real format represents a tool call (tool_use and its
 *     result are always two separate turns, never one), confirmed by direct inspection of a
 *     real, independently verified-resumable transcript.
 *   - IDs are opencode's own (msg_xxx, prt_xxx) reused directly as uuid/parentUuid. They are
 *     not RFC4122 UUIDs, but nothing in the resume path has been observed to validate that
 *     format — only uniqueness and a consistent parent chain matter.
 *
 * THIS IS THE HIGHEST-RISK PIECE OF THE MULTI-SOURCE IMPORT WORK: unlike Claude Desktop
 * (which needed no conversion — verified byte-identical format), this is genuinely synthesized
 * output. Do not trust it merely because it "looks right" — a converted session must actually
 * be resumed through a real Claude Code process end-to-end before this is considered done.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadSqlite } from './dsv4f-sources.mjs';

/**
 * CONFIRMED LIVE BUG (2026-08-12), now fixed: opencode's own IDs (ses_xxx/msg_xxx/prt_xxx)
 * were reused directly as Claude Code uuid/sessionId fields on the assumption that only
 * uniqueness and a consistent parent chain mattered. That assumption was wrong — a direct
 * resume attempt (`claude --resume ses_xxx --print`) failed outright: "not a UUID and does
 * not match any session title". Every id-shaped field in the converted output must be a
 * real RFC4122 UUID.
 *
 * Deterministic (not random) so re-converting the SAME opencode id on a later incremental
 * sync produces the SAME UUID rather than a fresh one each time — otherwise every re-import
 * would silently duplicate every session. This is UUID v5 (name-based, SHA-1) by hand: Node
 * has no built-in uuid-v5 function, but the algorithm is just "hash namespace+name, then set
 * the version/variant bits," which createHash covers without adding a dependency.
 */
// Arbitrary but FIXED namespace, private to dsv4f's opencode converter (not one of the
// standard RFC4122 namespaces — this tool has no reason to share one). Any constant 16-byte
// value works; what matters is that it never changes, since changing it would silently
// re-derive different UUIDs for every already-imported session on the next run.
const OPENCODE_UUID_NAMESPACE_HEX = 'a1b2c3d4e5f60708090a0b0c0d0e0f10';
export function deterministicUuid(seed) {
  const namespaceBytes = Buffer.from(OPENCODE_UUID_NAMESPACE_HEX, 'hex');
  const hash = crypto.createHash('sha1').update(namespaceBytes).update(String(seed)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Windows path -> the same kind of encoded project-directory name Claude Code itself uses. */
export function encodeProjectDir(cwd) {
  // Matches Claude Code's own scheme closely enough for a synthetic import: forward AND back
  // slashes become '-', a leading drive-letter colon is dropped rather than kept (":"  is not
  // filesystem-safe on Windows, and Claude Code's own encoder drops it the same way).
  return cwd.replace(/^([A-Za-z]):/, '$1').replace(/[\\/]+/g, '-');
}

function textOfParts(parts) {
  return parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

/**
 * Convert every part of one opencode message into Claude-shaped content blocks, plus any
 * synthetic tool_result blocks that must follow as a SEPARATE message (opencode bundles a
 * tool's input+output into one part; Claude's format never does — see file header).
 */
function convertParts(parts, unknownTypes) {
  const content = [];
  const pendingResults = []; // [{tool_use_id, content, is_error}]
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) content.push({ type: 'text', text: part.text });
        break;
      case 'reasoning':
      case 'step-start':
      case 'step-finish':
        break; // deliberately dropped — see file header
      case 'tool': {
        const state = part.state || {};
        content.push({
          type: 'tool_use',
          id: part.callID || part.id,
          name: part.tool || 'unknown_tool',
          input: state.input ?? {},
        });
        if (state.status === 'completed' || state.status === 'error' || 'output' in state) {
          pendingResults.push({
            tool_use_id: part.callID || part.id,
            content: typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? ''),
            is_error: state.status === 'error' || undefined,
          });
        }
        break;
      }
      default:
        unknownTypes.add(part.type);
        // Never silently drop content of an unrecognised shape — degrade visibly instead,
        // matching dsv4f-import's placeholder philosophy for images/documents.
        content.push({ type: 'text', text: `[opencode part type "${part.type}" — not converted; raw: ${JSON.stringify(part).slice(0, 300)}]` });
    }
  }
  return { content, pendingResults };
}

/**
 * Convert one opencode session to an array of Claude-Code-shaped transcript lines (objects,
 * not yet stringified). Caller decides the destination path and encodes the project dir.
 */
export function convertSession(db, sessionId, { cwd = '/' } = {}) {
  const session = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const directory = session.directory || cwd;

  // The session id itself is what `claude --resume <id>` validates as a UUID (confirmed via
  // a real failed resume attempt — see deterministicUuid's own comment). Every uuid/
  // parentUuid/promptId field below is real-UUID-shaped for the same reason: the one
  // genuinely-sampled Claude Code transcript checked for this project used real UUIDs in
  // exactly those three field kinds. tool_use.id/tool_result.tool_use_id are NOT UUIDs in
  // that same sample (Anthropic's own toolu_-prefixed scheme) — left as opencode's raw
  // callID there, since only tool_use/tool_result matching each other is required.
  const newSessionId = deterministicUuid(`session:${sessionId}`);
  const msgUuid = (id) => deterministicUuid(`message:${sessionId}:${id}`);

  const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId);
  // Hoisted out of the loop below — prepare() was re-parsing this same statement once per
  // message, when one prepared statement re-bound per iteration does the same job for free.
  const partsStmt = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC');

  const lines = [];
  const unknownTypes = new Set();
  let parentUuid = null;

  for (const msgRow of messages) {
    let data;
    try { data = JSON.parse(msgRow.data); } catch { data = {}; }
    const role = data.role === 'assistant' ? 'assistant' : 'user';
    const uuid = msgUuid(msgRow.id);

    const parts = partsStmt.all(msgRow.id)
      .map(p => { try { return JSON.parse(p.data); } catch { return { type: 'unknown', raw: p.data }; } });

    const timestamp = new Date(msgRow.time_created || Date.now()).toISOString();
    const base = {
      isSidechain: false,
      uuid,
      parentUuid,
      timestamp,
      userType: 'external',
      entrypoint: 'cli',
      cwd: directory,
      sessionId: newSessionId,
      version: '0.0.0-dsv4f-opencode-import',
      gitBranch: 'HEAD',
    };

    if (role === 'user') {
      const { content } = convertParts(parts, unknownTypes);
      const plainText = content.length === 1 && content[0].type === 'text';
      lines.push({
        ...base,
        type: 'user',
        promptId: uuid,
        message: { role: 'user', content: plainText ? content[0].text : content },
      });
      parentUuid = uuid;
      continue;
    }

    // assistant
    const { content, pendingResults } = convertParts(parts, unknownTypes);
    const finish = parts.find(p => p.type === 'step-finish');
    const tokens = finish?.tokens || {};
    lines.push({
      ...base,
      type: 'assistant',
      message: {
        model: data.model || session.model || 'unknown',
        id: msgRow.id,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: finish?.reason === 'tool-calls' ? 'tool_use' : (finish?.reason || 'end_turn'),
        stop_sequence: null,
        usage: {
          input_tokens: tokens.input || 0,
          output_tokens: tokens.output || 0,
          cache_creation_input_tokens: tokens.cache?.write || 0,
          cache_read_input_tokens: tokens.cache?.read || 0,
        },
      },
    });
    parentUuid = uuid;

    // Synthetic tool_result turn(s) — see file header. One synthetic user message carrying
    // every tool_result from this assistant turn, matching how a real client sends them
    // batched when multiple tools were called in parallel.
    if (pendingResults.length) {
      const resultUuid = deterministicUuid(`toolresults:${sessionId}:${msgRow.id}`);
      lines.push({
        ...base,
        uuid: resultUuid,
        parentUuid,
        type: 'user',
        promptId: resultUuid,
        message: {
          role: 'user',
          content: pendingResults.map(r => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: r.content,
            ...(r.is_error ? { is_error: true } : {}),
          })),
        },
      });
      parentUuid = resultUuid;
    }
  }

  return { lines, directory, title: session.title || null, unknownTypes: [...unknownTypes], sessionId: newSessionId };
}

/** List every session id + basic metadata in an opencode database. */
export function listSessions(dbPath) {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) throw new Error('node:sqlite unavailable (need Node 22.5+)');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT id, project_id, title, directory, time_created FROM session ORDER BY time_created ASC').all();
  db.close();
  return rows;
}

/** Open a database for conversion (not read-only — caller decides; convertSession itself never writes). */
export function openDb(dbPath) {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) throw new Error('node:sqlite unavailable (need Node 22.5+)');
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Write one convertSession() result to <outDir>/projects/<encoded-cwd>/<sessionId>.jsonl.
 * Shared by this file's own CLI entry point and dsv4f-setup-sources.mjs's import loop, which
 * used to duplicate this exact encode-mkdir-write sequence.
 *
 * @param {string} outDir   dsv4f profile root (NOT the projects dir itself — this appends it)
 * @param {{lines: object[], directory: string, sessionId: string}} result
 * @returns {string} the file path written
 */
export function writeConvertedSession(outDir, result) {
  const projDir = encodeProjectDir(result.directory);
  const dest = path.join(outDir, 'projects', projDir);
  fs.mkdirSync(dest, { recursive: true });
  // Filename MUST be the converted UUID, not opencode's own id -- Claude Code looks up a
  // resumed session by matching the sessionId field to the *filename*, not by scanning file
  // contents.
  const outFile = path.join(dest, `${result.sessionId}.jsonl`);
  fs.writeFileSync(outFile, result.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return outFile;
}

// ------------------------------------------------------------------ CLI entry point
// dsv4f-opencode-convert <db-path> [--session <id>] [--out <dir>] [--dry-run]

const isMain = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href; }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  if (!dbPath || dbPath.startsWith('--')) {
    console.error('Usage: dsv4f-opencode-convert <opencode.db path> [--session <id>] [--out <dir>] [--dry-run]');
    process.exit(1);
  }
  const sessionArg = (() => {
    const i = args.indexOf('--session');
    return i >= 0 ? args[i + 1] : null;
  })();
  const outDir = (() => {
    const i = args.indexOf('--out');
    return i >= 0 ? args[i + 1] : null;
  })();
  const dryRun = args.includes('--dry-run');

  const db = openDb(dbPath);
  const targets = sessionArg ? [sessionArg] : listSessions(dbPath).map(r => r.id);
  console.log(`converting ${targets.length} session(s) from ${dbPath}`);

  for (const id of targets) {
    let result;
    try { result = convertSession(db, id); }
    catch (e) { console.error(`  ${id}: FAILED — ${e.message}`); continue; }
    const projDir = encodeProjectDir(result.directory);
    console.log(`  ${id} -> ${result.sessionId}: ${result.lines.length} line(s), title="${result.title || ''}", project=${projDir}` +
      (result.unknownTypes.length ? `  UNKNOWN PART TYPES: ${result.unknownTypes.join(',')}` : ''));
    if (!dryRun && outDir) {
      const outFile = writeConvertedSession(outDir, result);
      console.log(`    wrote ${outFile}`);
    }
  }
  db.close();
}
