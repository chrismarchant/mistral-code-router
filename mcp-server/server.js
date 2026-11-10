#!/usr/bin/env node
'use strict';

/**
 * mistral-router MCP server — zero-dependency, stdio transport.
 *
 * Speaks MCP (JSON-RPC 2.0 over newline-delimited stdio) and proxies chat
 * completions to Mistral's OpenAI-compatible endpoint
 * (POST {MISTRAL_API_BASE}/chat/completions), which also hosts third-party
 * models such as Z.ai GLM 5.3 and DeepSeek V4.1 Flash.
 *
 * Tools:
 *   - mistral_models     : list the router's model aliases and target IDs
 *   - mistral_delegate   : send one workstream (task + file context) to a model
 *
 * No npm install required: uses only the Node standard library (Node >= 18
 * for global fetch).
 */

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const API_BASE = (process.env.MISTRAL_API_BASE || 'https://api.mistral.ai/v1').replace(/\/+$/, '');
const API_KEY = process.env.MISTRAL_API_KEY || '';
const MAX_CONTEXT_CHARS = parseInt(process.env.MAX_CONTEXT_CHARS || '200000', 10);

// Router model map. Alias -> Mistral-hosted model ID.
// Verify live IDs with: curl https://api.mistral.ai/v1/models -H "Authorization: Bearer $MISTRAL_API_KEY"
const MODELS = {
  lechonk: {
    id: 'mistral-large-4-0',
    label: 'Mistral Large 4 ("Le Chonk")',
    notes: '1M ctx, multimodal MoE (52B active / 1.05T total). Best for architecture, design reviews, complex refactors.',
  },
  glm: {
    id: 'zai-glm-5-3',
    label: 'Z.ai GLM 5.3',
    notes: 'Reasoning model, 1M ctx. Best for agentic multi-file coding workstreams.',
  },
  'glm-flash': {
    id: 'zai-glm-5-3-flash',
    label: 'Z.ai GLM 5.3 Flash',
    notes: 'Budget default; cheap high-volume generation (tests, docs, boilerplate).',
  },
  deepseek: {
    id: 'deepseek-v4-1-flash-1017',
    label: 'DeepSeek V4.1 Flash 1017',
    notes: '1M ctx, 128k max output. Long-context coding and agentic workflows.',
  },
};

const DEFAULT_SYSTEM =
  'You are a coding workstream offloaded from a Claude Code session. ' +
  'Produce precise, structured, implementation-ready output. When asked for JSON, return only JSON.';

function resolveModel(alias) {
  if (!alias || typeof alias !== 'string') {
    throw new Error(`model is required. Aliases: ${Object.keys(MODELS).join(', ')} (or pass a raw Mistral model ID).`);
  }
  const key = alias.toLowerCase();
  if (MODELS[key]) return MODELS[key].id;
  // Allow raw model IDs (e.g. "mistral-large-latest", "codestral-latest") to pass through.
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) return alias;
  throw new Error(`Unknown model alias "${alias}". Aliases: ${Object.keys(MODELS).join(', ')}.`);
}

function readFileContext(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const parts = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const f of files) {
    if (remaining <= 0) break;
    const p = path.resolve(process.cwd(), f);
    let content;
    try {
      content = fs.readFileSync(p, 'utf8');
    } catch (err) {
      parts.push(`<file path="${f}" error="unreadable: ${err.message}" />`);
      continue;
    }
    if (content.length > remaining) content = content.slice(0, remaining) + '\n... [truncated by MAX_CONTEXT_CHARS]';
    remaining -= content.length;
    parts.push(`<file path="${f}">\n${content}\n</file>`);
  }
  return parts.join('\n\n');
}

/* ---------- Shared Mistral API helper ---------- */

async function apiFetch(pathname, { method = 'GET', jsonBody, formData, timeoutMs = 120000 } = {}) {
  if (!API_KEY) {
    throw new Error('MISTRAL_API_KEY is not set. Set it in the Claude Code session env (e.g. .claude/settings.local.json "env") before using this plugin.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    const headers = { Authorization: `Bearer ${API_KEY}` };
    let body;
    if (formData) {
      body = formData; // fetch sets the multipart Content-Type + boundary
    } else if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }
    res = await fetch(`${API_BASE}${pathname}`, { method, headers, body, signal: ctrl.signal });
  } catch (err) {
    throw new Error(`Mistral API request failed: ${err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Mistral API error ${res.status} on ${method} ${pathname}: ${text.slice(0, 1000)}`);
  return text;
}

async function apiJson(pathname, opts) {
  const text = await apiFetch(pathname, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${pathname}: ${text.slice(0, 500)}`);
  }
}

/* ---------- Chat body builder (shared by live + batch) ---------- */

function buildChatBody(args, modelId) {
  const fileContext = readFileContext(args.files);
  const userBody = [
    args.context ? `<context>\n${args.context}\n</context>` : '',
    fileContext,
    `<task>\n${args.task}\n</task>`,
  ].filter(Boolean).join('\n\n');
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: args.system || DEFAULT_SYSTEM },
      { role: 'user', content: userBody },
    ],
    max_tokens: Number.isInteger(args.max_tokens) && args.max_tokens > 0 ? args.max_tokens : 8192,
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (args.json === true) body.response_format = { type: 'json_object' };
  return body;
}

/* ---------- Batch processing (https://docs.mistral.ai/inference/batch-processing) ---------- */

async function batchSubmit(args) {
  const modelId = resolveModel(args.model);
  const requests = args.requests;
  if (!Array.isArray(requests) || requests.length === 0) throw new Error('requests must be a non-empty array of workstreams.');
  const seen = new Set();
  const lines = requests.map((r, i) => {
    const customId = String(r.custom_id || `workstream-${i}`);
    if (seen.has(customId)) throw new Error(`Duplicate custom_id "${customId}" in requests.`);
    seen.add(customId);
    if (!r.task || typeof r.task !== 'string') throw new Error(`requests[${i}] (custom_id "${customId}") is missing "task".`);
    const body = buildChatBody(r, modelId);
    delete body.model; // model is set at job level; per-line model is optional
    return JSON.stringify({ custom_id: customId, body });
  });
  const jsonl = lines.join('\n') + '\n';

  // 1. Upload the JSONL input file with purpose "batch".
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
  const file = await apiJson('/files', { method: 'POST', formData: form, timeoutMs: 120000 });

  // 2. Create the batch job against the chat completions endpoint.
  const job = await apiJson('/batch/jobs', {
    method: 'POST',
    jsonBody: {
      input_file_id: file.id,
      endpoint: '/v1/chat/completions',
      model: modelId,
      completion_window: args.completion_window || '24h',
      metadata: { source: 'mistral-router', requests: String(lines.length) },
    },
    timeoutMs: 60000,
  });

  return JSON.stringify({
    job_id: job.id,
    status: job.status,
    model: modelId,
    request_count: lines.length,
    input_file_id: file.id,
    note: 'Async job. Poll with mistral_batch_status, then fetch mistral_batch_results once status is SUCCESS.',
  }, null, 2);
}

async function batchStatus(args) {
  if (!args.job_id) throw new Error('job_id is required.');
  const job = await apiJson(`/batch/jobs/${encodeURIComponent(args.job_id)}`, { timeoutMs: 30000 });
  return JSON.stringify(job, null, 2);
}

async function batchResults(args) {
  if (!args.job_id) throw new Error('job_id is required.');
  const job = await apiJson(`/batch/jobs/${encodeURIComponent(args.job_id)}`, { timeoutMs: 30000 });
  if (job.status !== 'SUCCESS') {
    return JSON.stringify({ job_id: args.job_id, status: job.status, results: [], note: 'Batch not finished yet; poll mistral_batch_status.' }, null, 2);
  }
  if (!job.output_file_id) throw new Error(`Job ${args.job_id} reported SUCCESS but has no output_file_id.`);
  const text = await apiFetch(`/files/${encodeURIComponent(job.output_file_id)}/content`, { timeoutMs: 60000 });
  const maxLines = Number.isInteger(args.max_lines) && args.max_lines > 0 ? args.max_lines : 100000;
  const results = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || results.length >= maxLines) continue;
    try {
      const row = JSON.parse(t);
      const resp = row.response || {};
      const body = resp.body || {};
      const choice = body.choices && body.choices[0];
      const failed = resp.status_code && resp.status_code >= 400;
      results.push({
        custom_id: row.custom_id,
        status_code: resp.status_code || null,
        error: failed ? (resp.error || body.error || body) : null,
        model: body.model || null,
        finish_reason: choice ? choice.finish_reason : null,
        usage: body.usage || null,
        content: choice && choice.message ? choice.message.content : null,
      });
    } catch { /* skip malformed output line */ }
  }
  return JSON.stringify({ job_id: args.job_id, status: job.status, results }, null, 2);
}

async function callMistral(args) {
  const modelId = resolveModel(args.model);
  const task = args.task;
  if (!task || typeof task !== 'string') throw new Error('task (string) is required.');

  const body = buildChatBody(args, modelId);
  const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : 120000;
  const data = await apiJson('/chat/completions', { method: 'POST', jsonBody: body, timeoutMs });
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return JSON.stringify({
    model: modelId,
    finish_reason: data.choices && data.choices[0] ? data.choices[0].finish_reason : null,
    usage: data.usage || null,
    content,
  }, null, 2);
}

const TOOLS = [
  {
    name: 'mistral_models',
    description:
      'List the model aliases this router can delegate to, with their Mistral API model IDs and guidance on when to use each.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mistral_delegate',
    description:
      'Offload one independent workstream to a Mistral-hosted model (Le Chonk / GLM 5.3 / DeepSeek V4.1 Flash) and return its structured result. ' +
      'Pass repo files via "files" (paths relative to the working directory; capped by MAX_CONTEXT_CHARS) and/or inline "context". ' +
      'Set json=true to force a strict JSON response.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: `Alias: ${Object.keys(MODELS).join(', ')} — or a raw Mistral model ID.`,
        },
        task: { type: 'string', description: 'The full workstream task/instructions for the remote model.' },
        system: { type: 'string', description: 'Optional system prompt override.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths (relative to cwd) to include as context. Total context is capped by MAX_CONTEXT_CHARS (default 200000).',
        },
        context: { type: 'string', description: 'Inline context (e.g. diffs, snippets, constraints).' },
        max_tokens: { type: 'integer', description: 'Max output tokens (default 8192).' },
        temperature: { type: 'number', description: 'Sampling temperature (optional).' },
        json: { type: 'boolean', description: 'If true, request strict JSON output via response_format.' },
        timeout_ms: { type: 'integer', description: 'Request timeout in ms (default 120000).' },
      },
      required: ['model', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'mistral_batch_submit',
    description:
      'Submit many independent workstreams as ONE asynchronous, discounted Mistral batch job ' +
      '(JSONL upload -> POST /v1/batch/jobs on /v1/chat/completions). Returns a job_id; poll with ' +
      'mistral_batch_status, then fetch mistral_batch_results. Best for >4 non-interactive workstreams ' +
      '(test/doc generation, per-file reviews). The remote model cannot use tools in batch mode.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: `Alias: ${Object.keys(MODELS).join(', ')} — or a raw model ID. Applied to every request in the batch.`,
        },
        requests: {
          type: 'array',
          description: 'One entry per workstream. custom_id is echoed in results so the coordinator can map back to the workstream.',
          items: {
            type: 'object',
            properties: {
              custom_id: { type: 'string', description: 'Unique ID for this workstream (default: workstream-<index>).' },
              task: { type: 'string', description: 'Full workstream task/instructions.' },
              system: { type: 'string' },
              files: { type: 'array', items: { type: 'string' }, description: 'File paths (relative to cwd) included as context, capped by MAX_CONTEXT_CHARS.' },
              context: { type: 'string' },
              max_tokens: { type: 'integer' },
              temperature: { type: 'number' },
              json: { type: 'boolean', description: 'Force strict JSON output via response_format.' },
            },
            required: ['task'],
            additionalProperties: false,
          },
        },
        completion_window: { type: 'string', description: 'Batch completion window, e.g. "24h" (default).' },
      },
      required: ['model', 'requests'],
      additionalProperties: false,
    },
  },
  {
    name: 'mistral_batch_status',
    description: 'Get the status of a Mistral batch job (GET /v1/batch/jobs/{job_id}).',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'mistral_batch_results',
    description:
      'Download and parse a finished batch job output file. Returns {job_id, status, results: [{custom_id, status_code, content, usage, error}]}. ' +
      'Returns an empty results list with the current status if the job is not SUCCESS yet.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        max_lines: { type: 'integer', description: 'Cap on output lines parsed (default 100000).' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
];

async function handleToolCall(name, args) {
  if (name === 'mistral_models') {
    const lines = Object.entries(MODELS).map(
      ([alias, m]) => `- ${alias} -> ${m.id} (${m.label}) — ${m.notes}`
    );
    return [
      `Router model map (endpoint: ${API_BASE}/chat/completions):`,
      ...lines,
      '',
      'Raw Mistral model IDs (e.g. mistral-large-latest, codestral-latest) are also accepted as "model".',
    ].join('\n');
  }
  if (name === 'mistral_delegate') {
    return await callMistral(args || {});
  }
  if (name === 'mistral_batch_submit') {
    return await batchSubmit(args || {});
  }
  if (name === 'mistral_batch_status') {
    return await batchStatus(args || {});
  }
  if (name === 'mistral_batch_results') {
    return await batchResults(args || {});
  }
  throw new Error(`Unknown tool: ${name}`);
}

/* ---------- Minimal MCP stdio plumbing (JSON-RPC 2.0, newline-delimited) ---------- */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'mistral-router', version: '0.1.0' };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      try {
        const text = await handleToolCall(params.name, params.arguments);
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        sendResult(id, {
          content: [{ type: 'text', text: String(err.message || err) }],
          isError: true,
        });
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON noise on stdin
  }
  if (msg.id === undefined || msg.id === null) return; // notification: nothing to answer
  handleRequest(msg).catch((err) => sendError(msg.id, -32603, String(err.message || err)));
});
