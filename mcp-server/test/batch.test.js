'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRouter, classifyBatchStatus, BillingBlockedError } = require('../server.js');
const { mkRoot, fakeFetch, ENV } = require('./helpers.js');

const has = (s) => (u) => u.includes(s);

function router(routes) {
  const fetch = fakeFetch(routes);
  const { root } = mkRoot();
  return { r: createRouter({ env: ENV, cwd: root, fetch }), fetch };
}

test('batch submit posts input_files array (not input_file_id) and returns both fields', async () => {
  const { r, fetch } = router([
    { method: 'POST', match: has('/files'), body: { id: 'file-123' } },
    { method: 'POST', match: has('/batch/jobs'), body: { id: 'job-1', status: 'QUEUED' } },
  ]);
  const out = JSON.parse(await r.batchSubmit({
    model: 'lechonk',
    requests: [{ custom_id: 'a', task: 't1', temperature: 0 }, { task: 't2' }],
    completion_window: '48h',
  }));
  assert.strictEqual(fetch.calls.length, 2);
  const jobBody = JSON.parse(fetch.calls[1].body);
  assert.deepStrictEqual(jobBody.input_files, ['file-123']);
  assert.ok(!('input_file_id' in jobBody));
  assert.strictEqual(jobBody.endpoint, '/v1/chat/completions');
  assert.strictEqual(jobBody.model, 'mistral-large-4-0');
  assert.strictEqual(jobBody.timeout_hours, 48);
  assert.deepStrictEqual(out.input_files, ['file-123']);
  assert.strictEqual(out.input_file_id, 'file-123');
  assert.strictEqual(out.job_id, 'job-1');
  assert.strictEqual(out.request_count, 2);
  // JSONL lines carry the model param policy (temperature 0 -> top_p 1 for Large 4).
  const blob = fetch.calls[0].body.get('file');
  const lines = (await blob.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines[0].custom_id, 'a');
  assert.strictEqual(lines[0].body.temperature, 0);
  assert.strictEqual(lines[0].body.top_p, 1);
  assert.strictEqual(lines[1].custom_id, 'workstream-1');
  assert.ok(!('model' in lines[0].body));
});

test('batch validation errors happen before any network call', async () => {
  const cases = [
    [{ model: 'glm', requests: [] }, /non-empty array/],
    [{ model: 'glm' }, /non-empty array/],
    [{ model: 'glm', requests: [{ custom_id: 'x', task: 'a' }, { custom_id: 'x', task: 'b' }] }, /Duplicate custom_id "x"/],
    [{ model: 'glm', requests: [{ task: '' }] }, /missing a non-empty "task"/],
    [{ model: 'glm', requests: [{ task: 5 }] }, /missing a non-empty "task"/],
    [{ model: 'glm', requests: ['nope'] }, /must be an object/],
    [{ model: 'glm', requests: [{ custom_id: 7, task: 'a' }] }, /custom_id must be a non-empty string/],
    [{ model: 'glm', requests: [{ task: 'a', temperature: 3 }] }, /temperature must be a finite number/],
    [{ model: 'glm', requests: [{ task: 'a' }], completion_window: '0h' }, /completion_window/],
    [{ model: 'glm', requests: [{ task: 'a' }], completion_window: '1000h' }, /completion_window/],
    [{ model: 'glm', requests: [{ task: 'a' }], completion_window: 'tomorrow' }, /completion_window/],
    [{ model: 'glm', requests: [{ task: 'a', files: ['../../etc/passwd'] }] }, /outside_root/],
  ];
  for (const [args, re] of cases) {
    const { r, fetch } = router([]);
    await assert.rejects(r.batchSubmit(args), re);
    assert.strictEqual(fetch.calls.length, 0, `no network for ${JSON.stringify(args)}`);
  }
});

test('HTTP 402 maps to a distinct, non-retryable billing-blocker error', async () => {
  const { r } = router([
    { method: 'POST', match: has('/files'), body: { id: 'file-1' } },
    { method: 'POST', match: has('/batch/jobs'), status: 402, body: { detail: 'payment required' } },
  ]);
  await assert.rejects(r.batchSubmit({ model: 'glm', requests: [{ task: 'x' }] }), (err) => {
    assert.ok(err instanceof BillingBlockedError);
    assert.strictEqual(err.code, 'MISTRAL_BILLING_402');
    assert.strictEqual(err.retryable, false);
    assert.match(err.message, /billing blocker, not a software fault\. Do not retry/);
    assert.ok(!err.message.includes(ENV.MISTRAL_API_KEY));
    return true;
  });
  const { r: r2 } = router([{ method: 'POST', match: has('/chat/completions'), status: 402, body: 'no credits' }]);
  await assert.rejects(r2.callMistral({ model: 'glm', task: 'x' }), /HTTP 402 Payment Required/);
});

test('other HTTP errors keep the truncated generic message', async () => {
  const { r } = router([{ method: 'POST', match: has('/chat/completions'), status: 500, body: 'x'.repeat(5000) }]);
  await assert.rejects(r.callMistral({ model: 'glm', task: 'x' }), (err) => {
    assert.match(err.message, /^Mistral API error 500 on POST \/chat\/completions: x+$/);
    assert.ok(err.message.length < 1100);
    return true;
  });
});

test('classifyBatchStatus covers pending, terminal and unknown states', () => {
  for (const s of ['QUEUED', 'RUNNING', 'CANCELLATION_REQUESTED']) assert.strictEqual(classifyBatchStatus(s).terminal, false);
  assert.deepStrictEqual(
    ['SUCCESS', 'FAILED', 'TIMEOUT_EXCEEDED', 'EXPIRED', 'CANCELLED'].map((s) => classifyBatchStatus(s).kind),
    ['success', 'failed', 'expired', 'expired', 'cancelled'],
  );
  const u = classifyBatchStatus('WEIRD');
  assert.strictEqual(u.terminal, false);
  assert.strictEqual(u.kind, 'unknown');
});

test('batch status adds router classification', async () => {
  const { r } = router([{ match: has('/batch/jobs/job-1'), body: { id: 'job-1', status: 'RUNNING' } }]);
  const out = JSON.parse(await r.batchStatus({ job_id: 'job-1' }));
  assert.strictEqual(out.status, 'RUNNING');
  assert.strictEqual(out.router.terminal, false);
  await assert.rejects(r.batchStatus({}), /job_id/);
});

test('batch results: non-terminal returns empty results without downloading', async () => {
  const { r, fetch } = router([{ match: has('/batch/jobs/j'), body: { id: 'j', status: 'QUEUED' } }]);
  const out = JSON.parse(await r.batchResults({ job_id: 'j' }));
  assert.strictEqual(out.terminal, false);
  assert.deepStrictEqual(out.results, []);
  assert.match(out.note, /not finished/);
  assert.strictEqual(fetch.calls.length, 1);
});

const okLine = (id, content) => JSON.stringify({
  custom_id: id,
  response: { status_code: 200, body: { model: 'm', usage: { total_tokens: 3 }, choices: [{ finish_reason: 'stop', message: { content } }] } },
});

test('batch results: SUCCESS parses output and strips thinking blocks', async () => {
  const out1 = [
    okLine('a', [{ type: 'thinking', thinking: [{ type: 'text', text: 'secret reasoning' }] }, { type: 'text', text: 'ans' }, { type: 'text', text: 'wer' }]),
    okLine('b', 'plain'),
    'not json',
  ].join('\n');
  const { r } = router([
    { match: has('/batch/jobs/j'), body: { id: 'j', status: 'SUCCESS', output_file: 'out-1' } },
    { match: has('/files/out-1/content'), body: out1 },
  ]);
  const out = JSON.parse(await r.batchResults({ job_id: 'j' }));
  assert.strictEqual(out.terminal, true);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.results.map((x) => x.content), ['answer', 'plain']);
  assert.ok(!JSON.stringify(out).includes('secret reasoning'));
  assert.match(out.note, /1 malformed/);
});

test('batch results: legacy output_file_id field is still honoured', async () => {
  const { r } = router([
    { match: has('/batch/jobs/j'), body: { id: 'j', status: 'SUCCESS', output_file_id: 'o' } },
    { match: has('/files/o/content'), body: okLine('a', 'x') },
  ]);
  assert.strictEqual(JSON.parse(await r.batchResults({ job_id: 'j' })).results[0].content, 'x');
});

test('batch results: SUCCESS with no output or error file is a clear error', async () => {
  const { r } = router([{ match: has('/batch/jobs/j'), body: { id: 'j', status: 'SUCCESS' } }]);
  await assert.rejects(r.batchResults({ job_id: 'j' }), /SUCCESS but has no output file and no error file/);
});

test('batch results: FAILED with error file and partial output', async () => {
  const errLine = JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: { message: 'bad' } } });
  const { r } = router([
    { match: has('/batch/jobs/j'), body: { id: 'j', status: 'FAILED', output_file: 'o', error_file: 'e', errors: [{ message: 'boom' }] } },
    { match: has('/files/o/content'), body: okLine('a', 'fine') },
    { match: has('/files/e/content'), body: errLine },
  ]);
  const out = JSON.parse(await r.batchResults({ job_id: 'j' }));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.results.length, 1);
  assert.deepStrictEqual(out.errors, [{ custom_id: 'b', status_code: 400, error: { message: 'bad' } }]);
  assert.deepStrictEqual(out.job_errors, [{ message: 'boom' }]);
  assert.match(out.note, /FAILED/);
  assert.match(out.note, /1 request\(s\) failed/);
});

test('batch results: CANCELLED / TIMEOUT_EXCEEDED with no files', async () => {
  for (const status of ['CANCELLED', 'TIMEOUT_EXCEEDED']) {
    const { r } = router([{ match: has('/batch/jobs/j'), body: { id: 'j', status } }]);
    const out = JSON.parse(await r.batchResults({ job_id: 'j' }));
    assert.strictEqual(out.terminal, true);
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.results, []);
    assert.match(out.note, new RegExp(status));
    assert.match(out.note, /No output file/);
  }
});
