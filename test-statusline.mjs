import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function usageServer(payload) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function render({ script, portEnv, payload, stdin, needle }) {
  const { server, port } = await usageServer(payload);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-statusline-'));
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, [portEnv]: String(port),
      MMCLAUDE_CONFIG_DIR: temp, MMCLAUDE_DATA_DIR: temp,
      DSV4SHIM_CONFIG_DIR: temp, DSV4SHIM_DATA_DIR: temp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(stdin));
  const result = await new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.code, 0, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout).toString();
  assert.ok(output.includes(needle), `expected statusline output to contain ${JSON.stringify(needle)}; got ${JSON.stringify(output)}`);
  return output;
}

const mmPayload = (fiveHour, weekly) => ({
  quota: { enabled: true, remainingPercent: fiveHour, weeklyRemainingPercent: weekly },
});
const mmInput = { effort: { level: 'high' } };
const yellow = '\x1b[33m';
const orange = '\x1b[38;5;208m';
const red = '\x1b[31m';

await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(50, 50), stdin: mmInput, needle: `${yellow}5h left 50%` });
await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(50, 50), stdin: mmInput, needle: `${yellow}Week left 50%` });
await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(30, 30), stdin: mmInput, needle: `${orange}5h left 30%` });
await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(30, 30), stdin: mmInput, needle: `${orange}Week left 30%` });
await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(10, 10), stdin: mmInput, needle: `${red}5h left 10%` });
await render({ script: 'bin/mmclaude-statusline.mjs', portEnv: 'MMCLAUDE_PORT',
  payload: mmPayload(10, 10), stdin: mmInput, needle: `${red}Week left 10%` });

console.log('statusline threshold tests: 6 passed');
