'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateApiBase, createRouter } = require('../server.js');
const { mkRoot, fakeFetch, ENV } = require('./helpers.js');

const SERVER = path.join(__dirname, '..', 'server.js');

test('API base allowlist: default and api.mistral.ai https only', () => {
  assert.deepStrictEqual(validateApiBase(undefined, false), { base: 'https://api.mistral.ai/v1', error: null });
  assert.strictEqual(validateApiBase('https://api.mistral.ai/v1/', false).base, 'https://api.mistral.ai/v1');
  assert.strictEqual(validateApiBase('https://API.MISTRAL.AI/v1', false).error, null);
  for (const bad of [
    'http://api.mistral.ai/v1',
    'https://evil.example/v1',
    'https://api.mistral.ai.evil.example/v1',
    'https://api.mistral.ai:8443/v1',
    'https://user:pw@api.mistral.ai/v1',
    'not a url',
  ]) {
    const r = validateApiBase(bad, false);
    assert.strictEqual(r.base, null, bad);
    assert.ok(r.error, bad);
  }
});

test('custom base allowed only with MISTRAL_ROUTER_ALLOW_CUSTOM_BASE=1', async () => {
  assert.strictEqual(validateApiBase('http://localhost:8080/v1', true).base, 'http://localhost:8080/v1');
  assert.ok(validateApiBase('file:///etc/passwd', true).error);

  const { root } = mkRoot();
  const fetch = fakeFetch([{ method: 'POST', match: () => true, body: { choices: [{ message: { content: 'x' } }] } }]);
  const blocked = createRouter({ env: { ...ENV, MISTRAL_API_BASE: 'https://evil.example/v1' }, cwd: root, fetch });
  await assert.rejects(blocked.callMistral({ model: 'glm', task: 't' }), /MISTRAL_API_BASE must be an https URL on api\.mistral\.ai/);
  assert.strictEqual(fetch.calls.length, 0);
  assert.match(await blocked.handleToolCall('mistral_models', {}), /endpoint REFUSED/);

  const allowed = createRouter({
    env: { ...ENV, MISTRAL_API_BASE: 'https://proxy.example/v1', MISTRAL_ROUTER_ALLOW_CUSTOM_BASE: '1' }, cwd: root, fetch,
  });
  await allowed.callMistral({ model: 'glm', task: 't' });
  assert.strictEqual(fetch.calls[0].url, 'https://proxy.example/v1/chat/completions');
});

test('missing key keeps the existing error text', async () => {
  const { root } = mkRoot();
  const r = createRouter({ env: {}, cwd: root, fetch: fakeFetch([]) });
  await assert.rejects(r.callMistral({ model: 'glm', task: 't' }), /MISTRAL_API_KEY is not set/);
});

test('MCP handshake lists exactly the 5 tools (child process, no network)', async () => {
  const { root } = mkRoot();
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { PATH: process.env.PATH, MISTRAL_API_KEY: 'dummy-not-a-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let buf = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('handshake timed out')); }, 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        responses.set(msg.id, msg);
        if (responses.has(1) && responses.has(2)) { clearTimeout(timer); resolve(); }
      }
    });
    child.on('error', reject);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await done;
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));

  assert.strictEqual(responses.get(1).result.serverInfo.name, 'mistral-router');
  assert.strictEqual(responses.get(1).result.protocolVersion, '2025-06-18');
  const names = responses.get(2).result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['mistral_batch_results', 'mistral_batch_status', 'mistral_batch_submit', 'mistral_delegate', 'mistral_models']);
});
