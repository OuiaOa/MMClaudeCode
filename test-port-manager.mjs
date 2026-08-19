import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmclaude-port-'));
const registry = path.join(root, 'registry.json');
process.env.CODEX_SHIM_PORT_REGISTRY = registry;
const { choosePort, configuredPort } = await import('./bin/mmclaude-port-manager.mjs');

const sibling = path.join(root, 'sibling');
const configDir = path.join(root, 'mmclaude-config');
const dataDir = path.join(root, 'mmclaude-data');
fs.mkdirSync(sibling, { recursive: true });
fs.writeFileSync(path.join(sibling, 'config.json'), JSON.stringify({ name: 'novacore', port: 45000 }));

const first = await choosePort({ app: 'mmclaude-test', configDir, dataDir, configPort: 45000, scanRoots: [root] });
assert.equal(first.preferredPort, 45000);
assert.equal(first.port, 45001, 'an installed sibling config reserves the preferred port');
assert.equal(configuredPort({ envVar: 'MMCLAUDE_TEST_PORT', app: 'mmclaude-test', dataDir, configPort: 45000 }), 45001);

const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(45001, '127.0.0.1', resolve); });
try {
  const second = await choosePort({ app: 'mmclaude-test', configDir, dataDir, configPort: 45000, scanRoots: [root] });
  assert.equal(second.port, 45002, 'a live listener advances to the next free port');
} finally {
  await new Promise(resolve => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('port manager: 2 passed, 0 failed');
