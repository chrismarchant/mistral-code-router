'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  createRouter, buildChatBody, applyModelParamPolicy, extractTextContent, validateTemperature, loadConfig,
} = require('../server.js');
const { mkRoot, fakeFetch, ENV } = require('./helpers.js');

function cfg() {
  const { root } = mkRoot();
  return loadConfig(ENV, root);
}

test('temperature 0 on mistral-large-4-0 adds top_p 1', () => {
  const body = buildChatBody({ task: 't', temperature: 0 }, 'mistral-large-4-0', cfg());
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.top_p, 1);
});

test('non-zero temperature on mistral-large-4-0 is unchanged', () => {
  const body = buildChatBody({ task: 't', temperature: 0.7 }, 'mistral-large-4-0', cfg());
  assert.strictEqual(body.temperature, 0.7);
  assert.ok(!('top_p' in body));
});

test('other models and raw IDs pass temperature 0 through unchanged', () => {
  for (const id of ['zai-glm-5-3', 'deepseek-v4-1-flash-1017', 'codestral-latest']) {
    const body = buildChatBody({ task: 't', temperature: 0 }, id, cfg());
    assert.strictEqual(body.temperature, 0);
    assert.ok(!('top_p' in body), id);
  }
  assert.deepStrictEqual(applyModelParamPolicy('unknown-x', { temperature: 0 }), { temperature: 0 });
});

test('no temperature -> none sent', () => {
  const body = buildChatBody({ task: 't' }, 'mistral-large-4-0', cfg());
  assert.ok(!('temperature' in body));
  assert.ok(!('top_p' in body));
});

test('invalid temperature is a clear error', () => {
  for (const t of [-0.1, 2.5, NaN, Infinity, '0.5', true]) {
    assert.throws(() => validateTemperature(t), /temperature must be a finite number in \[0, 2\]/);
  }
  assert.strictEqual(validateTemperature(2), 2);
  assert.strictEqual(validateTemperature(undefined), undefined);
  assert.throws(() => buildChatBody({ task: 't', temperature: 9 }, 'zai-glm-5-3', cfg()), /temperature/);
});

test('live delegate via lechonk alias sends top_p 1 with temperature 0', async () => {
  const { root } = mkRoot();
  const fetch = fakeFetch([{ method: 'POST', match: (u) => u.endsWith('/chat/completions'), body: { choices: [{ message: { content: 'ok' } }] } }]);
  const r = createRouter({ env: ENV, cwd: root, fetch });
  await r.callMistral({ model: 'lechonk', task: 't', temperature: 0 });
  const sent = JSON.parse(fetch.calls[0].body);
  assert.strictEqual(sent.model, 'mistral-large-4-0');
  assert.strictEqual(sent.top_p, 1);
  assert.strictEqual(fetch.calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
});

test('extractTextContent: strings pass, arrays keep only text blocks', () => {
  assert.strictEqual(extractTextContent('plain'), 'plain');
  assert.strictEqual(extractTextContent([
    { type: 'thinking', thinking: [{ type: 'text', text: 'hidden' }] },
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]), 'ab');
  assert.strictEqual(extractTextContent(null), '');
  assert.strictEqual(extractTextContent([{ type: 'thinking', thinking: 'x' }]), '');
});

test('mistral_delegate returns string content without thinking blocks', async () => {
  const { root } = mkRoot();
  const fetch = fakeFetch([{
    method: 'POST',
    match: () => true,
    body: {
      usage: { total_tokens: 5 },
      choices: [{ finish_reason: 'stop', message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'REASONING' }] }, { type: 'text', text: '{"ok":true}' }] } }],
    },
  }]);
  const r = createRouter({ env: ENV, cwd: root, fetch });
  const out = JSON.parse(await r.handleToolCall('mistral_delegate', { model: 'glm', task: 't' }));
  assert.strictEqual(out.content, '{"ok":true}');
  assert.strictEqual(typeof out.content, 'string');
  assert.ok(!JSON.stringify(out).includes('REASONING'));
});
