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
 * Tools: mistral_models, mistral_delegate, mistral_batch_submit,
 *        mistral_batch_status, mistral_batch_results.
 *
 * No npm install required: uses only the Node standard library (Node >= 18
 * for global fetch / FormData / Blob).
 *
 * The module is importable without starting the stdio loop (see module.exports);
 * `createRouter({ env, cwd, fetch })` builds an instance with injected config.
 */

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

/* ---------- Models ---------- */

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

// Per-model request parameter policy. Keyed by resolved model ID; unknown/raw IDs
// pass parameters through unchanged.
//   greedyRequiresTopP1: the API rejects temperature 0 unless top_p is 1
//   ("top_p must be 1 when using greedy sampling", HTTP 400).
// Lookup is by lowercased model ID. "mistral-large-4" is a known alias of Large 4.
// "mistral-large-latest" is deliberately NOT listed: it resolves to a different model today.
const LARGE_4_POLICY = { greedyRequiresTopP1: true };
const MODEL_PARAM_POLICIES = {
  'mistral-large-4-0': LARGE_4_POLICY,
  'mistral-large-4': LARGE_4_POLICY,
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

function validateTemperature(t) {
  if (t === undefined || t === null) return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) {
    throw new Error(`temperature must be a finite number in [0, 2] (got ${typeof t === 'number' ? String(t) : JSON.stringify(t)}).`);
  }
  return t;
}

/** Apply MODEL_PARAM_POLICIES to sampling params (mutates and returns body). */
function applyModelParamPolicy(modelId, body) {
  const policy = MODEL_PARAM_POLICIES[String(modelId).toLowerCase()];
  if (!policy) return body;
  if (policy.greedyRequiresTopP1 && body.temperature === 0) body.top_p = 1;
  return body;
}

/** Return only the concatenated text blocks of a chat message content (never thinking blocks). */
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

/* ---------- Configuration ---------- */

const DEFAULT_API_BASE = 'https://api.mistral.ai/v1';
const ALLOWED_API_HOST = 'api.mistral.ai';
const DEFAULT_MAX_CONTEXT_CHARS = 200000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 50;

function positiveInt(raw, dflt) {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

/** Returns { base, error }. error is set when the base URL is refused. */
function validateApiBase(raw, allowCustom) {
  const value = raw === undefined || raw === null || raw === '' ? DEFAULT_API_BASE : String(raw);
  let url;
  try {
    url = new URL(value);
  } catch {
    return { base: null, error: 'MISTRAL_API_BASE is not a valid URL; refusing to send requests.' };
  }
  if (url.username || url.password) {
    return { base: null, error: 'MISTRAL_API_BASE must not contain credentials; refusing to send requests.' };
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  if (allowCustom) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { base: null, error: 'MISTRAL_API_BASE must be an http(s) URL; refusing to send requests.' };
    }
    return { base, error: null };
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== ALLOWED_API_HOST || url.port !== '') {
    return {
      base: null,
      error: `MISTRAL_API_BASE must be an https URL on ${ALLOWED_API_HOST} (got host "${url.hostname}", protocol "${url.protocol}"). ` +
        'Refusing to send the API key elsewhere. Set MISTRAL_ROUTER_ALLOW_CUSTOM_BASE=1 to allow a custom endpoint.',
    };
  }
  return { base, error: null };
}

function realpathNative(p) {
  return (fs.realpathSync.native || fs.realpathSync)(p);
}

// Never approvable as roots, and files under them are never read (unsafe_path).
const PSEUDO_FS_DIRS = ['/proc', '/sys', '/dev'];
// Never approvable as roots, including their subdirectories.
const SYSTEM_TREE_DIRS = ['/etc', '/root', '/boot'];
// Never approvable as roots themselves; a root strictly under them (e.g. /var/www/app, /opt/project) is fine.
const SYSTEM_EXACT_DIRS = ['/var', '/usr', '/opt', '/srv', '/bin', '/sbin', '/lib', '/lib64', '/run'];

function isPseudoFsPath(real) {
  return process.platform !== 'win32' && PSEUDO_FS_DIRS.some((d) => isInside(real, d));
}

let systemExactCache = null;
function systemExactDirs() {
  if (!systemExactCache) {
    systemExactCache = new Set(SYSTEM_EXACT_DIRS);
    // On merged-/usr systems /bin etc. are symlinks; refuse their canonical targets too.
    for (const d of SYSTEM_EXACT_DIRS) { try { systemExactCache.add(realpathNative(d)); } catch { /* absent */ } }
  }
  return systemExactCache;
}

/**
 * Why a canonical directory may not be an approved root, or null if it may.
 * System directories can never be approved. "/", the home directory itself and any
 * directory that contains the home directory can be opted into (allowUnsafe).
 */
function unsafeRootReason(real, homeReal, allowUnsafe) {
  if (process.platform !== 'win32') {
    if (isPseudoFsPath(real)) return 'is inside a system pseudo-filesystem (/proc, /sys, /dev)';
    if (SYSTEM_TREE_DIRS.some((d) => isInside(real, d))) return 'is inside a system directory (/etc, /root, /boot)';
    if (systemExactDirs().has(real)) return 'is a system directory';
  }
  if (allowUnsafe) return null;
  if (path.parse(real).root === real) return 'is the filesystem root';
  if (homeReal && real === homeReal) return 'is the home directory itself';
  if (homeReal && isInside(homeReal, real)) return 'contains the home directory';
  return null;
}

/**
 * Canonicalise approved workspace roots: cwd + MISTRAL_ROUTER_ALLOWED_ROOTS (path-delimiter separated).
 * Returns { roots, cwdError }. cwdError is set when the working directory is an unsafe root; the
 * files parameter then fails closed. Unsafe extra roots are ignored (never approved).
 */
function canonicalRoots(cwd, extra, warn = () => {}, { homedir = os.homedir(), allowUnsafe = false } = {}) {
  const roots = [];
  let cwdError = null;
  let homeReal = null;
  try { homeReal = homedir ? realpathNative(homedir) : null; } catch { /* no usable home */ }
  const add = (raw, label, isCwd) => {
    try {
      const real = realpathNative(path.resolve(cwd, raw));
      if (!fs.statSync(real).isDirectory()) { warn(`${label} is not a directory; ignored.`); return; }
      const unsafe = unsafeRootReason(real, homeReal, allowUnsafe);
      if (unsafe) {
        if (isCwd) cwdError = `the server working directory ${unsafe} and cannot be a workspace root`;
        warn(`${label} ${unsafe}; refused as a workspace root.`);
        return;
      }
      if (!roots.some((r) => r.real === real)) roots.push({ raw: path.resolve(cwd, raw), real });
    } catch {
      warn(`${label} cannot be resolved; ignored.`);
    }
  };
  add(cwd, 'working directory root', true);
  if (extra) {
    for (const r of String(extra).split(path.delimiter)) {
      if (r.trim()) add(r.trim(), `MISTRAL_ROUTER_ALLOWED_ROOTS entry "${r.trim()}"`, false);
    }
  }
  return { roots, cwdError };
}

function loadConfig(env = process.env, cwd = process.cwd(), warn = () => {}, { homedir } = {}) {
  const allowCustomBase = env.MISTRAL_ROUTER_ALLOW_CUSTOM_BASE === '1';
  const { base, error } = validateApiBase(env.MISTRAL_API_BASE, allowCustomBase);
  const { roots, cwdError } = canonicalRoots(cwd, env.MISTRAL_ROUTER_ALLOWED_ROOTS, warn, {
    homedir: homedir === undefined ? os.homedir() : homedir,
    allowUnsafe: env.MISTRAL_ROUTER_ALLOW_UNSAFE_ROOT === '1',
  });
  return {
    apiBase: base,
    apiBaseError: error,
    apiKey: env.MISTRAL_API_KEY || '',
    cwd,
    maxContextChars: positiveInt(env.MAX_CONTEXT_CHARS, DEFAULT_MAX_CONTEXT_CHARS),
    maxFileBytes: positiveInt(env.MISTRAL_ROUTER_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxFiles: positiveInt(env.MISTRAL_ROUTER_MAX_FILES, DEFAULT_MAX_FILES),
    roots,
    rootsError: cwdError,
  };
}

/* ---------- File sandbox ---------- */

class FileRejectedError extends Error {
  constructor(given, reason, detail) {
    super(`${JSON.stringify(given)} -> ${reason}${detail ? ` (${detail})` : ''}`);
    this.given = given;
    this.reason = reason;
  }
}

function isInside(child, root) {
  const rel = path.relative(root, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function findRoot(p, roots, key) {
  return roots.find((r) => isInside(p, r[key])) || null;
}

const SENSITIVE_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.git', '.kube', '.azure']);
// Directory pairs: [parent, child]; child may be a directory or a file.
const SENSITIVE_PAIRS = [
  ['.docker', 'config.json'], ['gh', 'hosts.yml'], ['gh', 'hosts.yaml'], ['.config', 'gcloud'],
];
const SENSITIVE_BASENAMES = new Set([
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.claude.json', 'settings.local.json',
  'credentials', 'credentials.json', 'application_default_credentials.json', '.git',
  '.git-credentials', '.pgpass', '.htpasswd', '.vault-token', '.dockercfg', '.my.cnf', '.s3cfg', '.boto',
  'kubeconfig', '.histfile', '.lesshst', '.viminfo',
]);
// Any dot-separated component of the basename (after the first) matching one of these is refused:
// x.pem, k.pem.txt, server.key, a.key.bak, prod.tfvars.json, x.tfstate.backup, k.ppk ...
const SENSITIVE_NAME_PARTS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'tfstate', 'tfvars', 'kubeconfig']);
const SSH_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template']);
const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template)$/;
const ENV_STAGE_NAME = /^env\.(local|dev|development|prod|production|staging|stage|test|secret|secrets)(\..*)?$/;
const HISTORY_NAME = /^\.?[a-z0-9_-]*_history$/;

const CONTENT_RULES = [
  // Require key material, not just the marker, so files that merely quote the markers are allowed:
  // a PEM/PGP header followed within ~200 chars by a run of 40+ base64 characters ...
  // A marker alone is not enough (files may quote it). Key material must follow within 2000
  // characters: either one run of 40+ base64 characters, or two consecutive lines that are
  // pure base64 of 16+ characters each (keys wrapped at a narrow width). Line breaks may be
  // real or JSON-escaped.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]{0,2000}?(?:[A-Za-z0-9+/=]{40,}|(?:\n|\\n)[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*(?:\r|\\r)?(?:\n|\\n)[ \t]*[A-Za-z0-9+/=]{16,})/, 'contains a PEM/PGP private key'],
  // ... and a PuTTY key file that actually has its private section.
  [/PuTTY-User-Key-File-[\s\S]{0,8000}?Private-Lines[:]/, 'contains a PuTTY private key'],
  [/aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i, 'contains an AWS secret access key'],
  [/(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/, 'contains an AWS access key id'],
];

/** Returns a reason string if the path (segments relative to its root) is sensitive, else null. */
function sensitiveMatch(relPath) {
  const segs = relPath.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length === 0) return null;
  const base = segs[segs.length - 1];
  for (const s of segs.slice(0, -1)) {
    if (SENSITIVE_DIR_SEGMENTS.has(s)) return `inside ${s}/`;
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if (SENSITIVE_PAIRS.some(([a, b]) => segs[i] === a && segs[i + 1] === b)) return `${segs[i]}/${segs[i + 1]}`;
  }
  // Environment files: .env, .env.*, .envrc, .env~, .env-prod, prod.env, a.env.local, env.local ...
  if (!ENV_ALLOWED.has(base)) {
    if (base.startsWith('.env') || base.endsWith('.env') || ENV_STAGE_NAME.test(base)
      || (base.includes('.env.') && !ENV_TEMPLATE_SUFFIX.test(base))) return 'environment file';
  }
  if (SENSITIVE_BASENAMES.has(base)) return `sensitive file name ${base}`;
  if (SSH_KEY_PREFIXES.some((p) => base.startsWith(p))) return 'ssh key file';
  if (base.startsWith('secrets.')) return 'secrets file';
  if (HISTORY_NAME.test(base)) return 'shell history';
  const part = base.split('.').slice(1).find((p) => SENSITIVE_NAME_PARTS.has(p));
  if (part) return `sensitive name component .${part}`;
  return null;
}

/** Returns a reason if file content looks like key material, else null. Never returns content. */
function sensitiveContent(buf) {
  const text = buf.toString('latin1');
  // Second pass with NULs removed catches UTF-16 (LE/BE, with or without BOM) encodings of ASCII headers.
  const candidates = text.includes('\0') ? [text, text.replace(/\0/g, '')] : [text];
  for (const c of candidates) {
    for (const [re, why] of CONTENT_RULES) if (re.test(c)) return why;
  }
  return null;
}

/**
 * Validate one requested path against the sandbox. Returns { given, real, lexical, size, dev, ino }.
 * Throws FileRejectedError with reason: outside_root | symlink_escape | sensitive |
 * not_regular_file | hard_link | too_large | not_found | unsafe_path.
 */
function resolveSandboxedFile(given, cfg) {
  if (typeof given !== 'string' || given === '' || given.includes('\0')) {
    throw new FileRejectedError(given, 'not_found', 'path must be a non-empty string');
  }
  const lexical = path.resolve(cfg.cwd, given);
  let cwdReal = cfg.cwd;
  try { cwdReal = realpathNative(cfg.cwd); } catch { /* keep as given */ }
  const lexicalAlt = path.resolve(cwdReal, given);
  // Lexical (pre-symlink) containment: used to tell symlink_escape from outside_root and
  // to apply sensitive-name rules to the path as requested.
  let lexRel = null;
  for (const [p, key] of [[lexical, 'raw'], [lexicalAlt, 'real'], [lexical, 'real']]) {
    const r = findRoot(p, cfg.roots, key);
    if (r) { lexRel = path.relative(r[key], p); break; }
  }
  const lexRoot = lexRel !== null;

  let real;
  try {
    real = realpathNative(lexical);
  } catch {
    if (isPseudoFsPath(lexical)) throw new FileRejectedError(given, 'unsafe_path', 'under /proc, /sys or /dev');
    if (!lexRoot) throw new FileRejectedError(given, 'outside_root');
    throw new FileRejectedError(given, 'not_found');
  }
  if (isPseudoFsPath(real)) throw new FileRejectedError(given, 'unsafe_path', 'under /proc, /sys or /dev');
  const root = findRoot(real, cfg.roots, 'real');
  if (!root) {
    throw new FileRejectedError(given, lexRoot ? 'symlink_escape' : 'outside_root');
  }
  // Sensitive exclusions: on the canonical path (relative to its root) and on the path as requested.
  const why = sensitiveMatch(path.relative(root.real, real))
    || (lexRoot ? sensitiveMatch(lexRel) : null);
  if (why) throw new FileRejectedError(given, 'sensitive', why);

  let st;
  try { st = fs.statSync(real); } catch { throw new FileRejectedError(given, 'not_found'); }
  if (!st.isFile()) throw new FileRejectedError(given, 'not_regular_file');
  // Conservative: a hard link can alias a file that lives outside the roots, and the
  // path alone cannot tell us, so any regular file with more than one link is refused.
  if (st.nlink > 1) throw new FileRejectedError(given, 'hard_link', `${st.nlink} links`);
  if (st.size > cfg.maxFileBytes) {
    throw new FileRejectedError(given, 'too_large', `${st.size} bytes > per-file cap ${cfg.maxFileBytes}`);
  }
  return { given, real, lexical, size: st.size, dev: st.dev, ino: st.ino };
}

/** Open and read a checked entry, verifying the opened file is the one that was checked. */
function readCheckedFile(entry, cfg, { procFd = fs.existsSync('/proc/self/fd') } = {}) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(entry.real, flags);
  } catch {
    throw new FileRejectedError(entry.given, 'changed_during_read', 'could not open the checked file');
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== entry.dev || st.ino !== entry.ino) {
      throw new FileRejectedError(entry.given, 'changed_during_read', 'file identity changed after the check');
    }
    if (!st.isFile()) throw new FileRejectedError(entry.given, 'not_regular_file');
    if (st.nlink > 1) throw new FileRejectedError(entry.given, 'hard_link');
    if (st.size > cfg.maxFileBytes) throw new FileRejectedError(entry.given, 'too_large');
    // Where the kernel exposes it, confirm where the open descriptor really points
    // (defends against a parent directory being swapped for a symlink after the check).
    if (procFd) {
      let fdReal;
      try { fdReal = realpathNative(`/proc/self/fd/${fd}`); } catch { fdReal = null; }
      const fdRoot = fdReal ? findRoot(fdReal, cfg.roots, 'real') : null;
      if (!fdRoot || isPseudoFsPath(fdReal) || sensitiveMatch(path.relative(fdRoot.real, fdReal))) {
        throw new FileRejectedError(entry.given, 'changed_during_read', 'opened file is no longer an approved path');
      }
    }
    // Portable re-check (the only one where /proc/self/fd is unavailable): the path as
    // requested must still resolve inside an approved root, to the very file that is open.
    let again = null;
    try {
      const real2 = realpathNative(entry.lexical || entry.real);
      const st2 = fs.statSync(real2);
      if (st2.dev === st.dev && st2.ino === st.ino && findRoot(real2, cfg.roots, 'real') && !isPseudoFsPath(real2)) again = real2;
    } catch { /* treated as changed */ }
    if (!again) {
      throw new FileRejectedError(entry.given, 'changed_during_read', 'path no longer resolves to the opened file inside an approved root');
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const data = buf.subarray(0, off);
    const why = sensitiveContent(data);
    if (why) throw new FileRejectedError(entry.given, 'sensitive', why);
    return data.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Read sandboxed file context. Fails closed: any rejected path fails the whole call
 * (error names each path as given and the reason; never file contents).
 */
function readFileContext(files, cfg) {
  if (files === undefined || files === null) return '';
  if (!Array.isArray(files)) throw new Error('files must be an array of path strings.');
  if (files.length === 0) return '';
  if (cfg.rootsError) {
    throw new Error(`File context rejected (no request sent): ${cfg.rootsError} -> unsafe_root. ` +
      'Start the server in a project directory to use "files"; other tools and inline "context" still work.');
  }
  if (files.length > cfg.maxFiles) {
    throw new Error(`File context rejected (no request sent): ${files.length} files requested > cap ${cfg.maxFiles} (MISTRAL_ROUTER_MAX_FILES) -> too_many_files.`);
  }
  const rejected = [];
  const entries = [];
  const fail = () => new Error(`File context rejected (no request sent): ${rejected.map((e) => e.message).join('; ')}`);
  for (const f of files) {
    try { entries.push(resolveSandboxedFile(f, cfg)); } catch (err) {
      if (err instanceof FileRejectedError) rejected.push(err); else throw err;
    }
  }
  if (rejected.length) throw fail();
  const contents = [];
  for (const e of entries) {
    try { contents.push(readCheckedFile(e, cfg)); } catch (err) {
      if (err instanceof FileRejectedError) rejected.push(err); else throw err;
    }
  }
  if (rejected.length) throw fail();

  // Per-call random tag name so file content cannot forge a closing delimiter.
  let tag;
  do { tag = `file-${crypto.randomBytes(6).toString('hex')}`; } while (contents.some((c) => c.includes(tag)));

  const parts = [];
  let remaining = cfg.maxContextChars;
  entries.forEach((e, i) => {
    const attr = escapeAttr(e.given);
    if (remaining <= 0) {
      parts.push(`<${tag} path="${attr}" omitted="MAX_CONTEXT_CHARS reached" />`);
      return;
    }
    let content = contents[i];
    if (content.length > remaining) content = content.slice(0, remaining) + '\n... [truncated by MAX_CONTEXT_CHARS]';
    remaining -= Math.min(contents[i].length, remaining);
    parts.push(`<${tag} path="${attr}">\n${content}\n</${tag}>`);
  });
  return parts.join('\n\n');
}

/* ---------- Chat body builder (shared by live + batch) ---------- */

function buildChatBody(args, modelId, cfg) {
  const temperature = validateTemperature(args.temperature);
  const fileContext = readFileContext(args.files, cfg);
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
  if (temperature !== undefined) body.temperature = temperature;
  if (args.json === true) body.response_format = { type: 'json_object' };
  return applyModelParamPolicy(modelId, body);
}

/* ---------- Batch helpers ---------- */

const BATCH_TERMINAL = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT_EXCEEDED: 'expired',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};
const BATCH_PENDING = new Set(['QUEUED', 'RUNNING', 'CANCELLATION_REQUESTED', 'VALIDATING', 'IN_PROGRESS']);

function classifyBatchStatus(status) {
  const s = String(status || '').toUpperCase();
  if (BATCH_TERMINAL[s]) {
    const kind = BATCH_TERMINAL[s];
    const note = kind === 'success'
      ? 'Batch finished; fetch mistral_batch_results.'
      : `Batch ended in state ${s} (${kind}); successful lines (if any) and the error file are available via mistral_batch_results. Do not re-poll.`;
    return { terminal: true, kind, note };
  }
  if (BATCH_PENDING.has(s)) {
    return { terminal: false, kind: 'pending', note: `Batch not finished (state ${s}); poll mistral_batch_status again later.` };
  }
  return { terminal: false, kind: 'unknown', note: `Unrecognised batch state ${JSON.stringify(status)}; treat as not finished and poll again.` };
}

function parseCompletionWindow(w) {
  if (w === undefined || w === null || w === '') return 24;
  const m = typeof w === 'string' ? /^(\d{1,3})h$/.exec(w.trim()) : null;
  const hours = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new Error(`completion_window must be a string like "24h" between 1h and 168h (got ${JSON.stringify(w)}).`);
  }
  return hours;
}

/** Validate batch requests without any I/O beyond the sandboxed file reads in buildChatBody. */
function validateBatchRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('requests must be a non-empty array of workstreams.');
  }
  const seen = new Set();
  return requests.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`requests[${i}] must be an object.`);
    if (r.custom_id !== undefined && (typeof r.custom_id !== 'string' || r.custom_id.trim() === '')) {
      throw new Error(`requests[${i}].custom_id must be a non-empty string when provided.`);
    }
    const customId = r.custom_id !== undefined ? r.custom_id : `workstream-${i}`;
    if (customId.length > 256) throw new Error(`requests[${i}].custom_id is longer than 256 characters.`);
    if (seen.has(customId)) throw new Error(`Duplicate custom_id "${customId}" in requests.`);
    seen.add(customId);
    if (typeof r.task !== 'string' || r.task.trim() === '') {
      throw new Error(`requests[${i}] (custom_id "${customId}") is missing a non-empty "task" string.`);
    }
    validateTemperature(r.temperature);
    return customId;
  });
}

function parseJsonl(text, maxLines) {
  const rows = [];
  let malformed = 0;
  let truncated = false;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (rows.length >= maxLines) { truncated = true; break; }
    try { rows.push(JSON.parse(t)); } catch { malformed++; }
  }
  return { rows, malformed, truncated };
}

function summariseResultRow(row) {
  const resp = row.response || {};
  const body = resp.body || {};
  const choice = body.choices && body.choices[0];
  const statusCode = resp.status_code || null;
  const failed = (statusCode && statusCode >= 400) || Boolean(row.error);
  return {
    custom_id: row.custom_id,
    status_code: statusCode,
    error: failed ? (row.error || resp.error || body.error || body) : null,
    model: body.model || null,
    finish_reason: choice ? choice.finish_reason : null,
    usage: body.usage || null,
    content: choice && choice.message ? extractTextContent(choice.message.content) : null,
  };
}

/* ---------- Router instance (config + fetch injected) ---------- */

class BillingBlockedError extends Error {
  constructor(method, pathname, body) {
    super(
      `Mistral API returned HTTP 402 Payment Required on ${method} ${pathname}: account-level billing blocker, ` +
      'not a software fault. Do not retry; resolve billing/credits for this API key in the Mistral console first. ' +
      `Response: ${String(body).slice(0, 300)}`,
    );
    this.code = 'MISTRAL_BILLING_402';
    this.httpStatus = 402;
    this.retryable = false;
  }
}

function createRouter({ env = process.env, cwd = process.cwd(), fetch: fetchImpl = globalThis.fetch, warn, homedir } = {}) {
  const cfg = loadConfig(env, cwd, warn, { homedir });

  async function apiFetch(pathname, { method = 'GET', jsonBody, formData, timeoutMs = 120000 } = {}) {
    if (cfg.apiBaseError) throw new Error(cfg.apiBaseError);
    if (!cfg.apiKey) {
      throw new Error('MISTRAL_API_KEY is not set. Set it in the Claude Code session env (e.g. .claude/settings.local.json "env") before using this plugin.');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
      const headers = { Authorization: `Bearer ${cfg.apiKey}` };
      let body;
      if (formData) {
        body = formData; // fetch sets the multipart Content-Type + boundary
      } else if (jsonBody !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(jsonBody);
      }
      res = await fetchImpl(`${cfg.apiBase}${pathname}`, { method, headers, body, signal: ctrl.signal, redirect: 'error' });
      text = await res.text();
    } catch (err) {
      throw new Error(`Mistral API request failed: ${err && err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err && err.message)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 402) throw new BillingBlockedError(method, pathname, text);
    if (!res.ok) {
      const err = new Error(`Mistral API error ${res.status} on ${method} ${pathname}: ${text.slice(0, 1000)}`);
      err.httpStatus = res.status;
      throw err;
    }
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

  async function callMistral(args) {
    const modelId = resolveModel(args.model);
    if (!args.task || typeof args.task !== 'string') throw new Error('task (string) is required.');
    const body = buildChatBody(args, modelId, cfg);
    const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : 120000;
    const data = await apiJson('/chat/completions', { method: 'POST', jsonBody: body, timeoutMs });
    const choice = data.choices && data.choices[0];
    return JSON.stringify({
      model: modelId,
      finish_reason: choice ? choice.finish_reason : null,
      usage: data.usage || null,
      content: choice && choice.message ? extractTextContent(choice.message.content) : '',
    }, null, 2);
  }

  async function batchSubmit(args) {
    const modelId = resolveModel(args.model);
    const timeoutHours = parseCompletionWindow(args.completion_window);
    const ids = validateBatchRequests(args.requests);
    // Build every line (incl. sandboxed file reads) before any network call.
    const lines = args.requests.map((r, i) => {
      const body = buildChatBody(r, modelId, cfg);
      delete body.model; // model is set at job level
      return JSON.stringify({ custom_id: ids[i], body });
    });
    const jsonl = lines.join('\n') + '\n';

    // 1. Upload the JSONL input file with purpose "batch".
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch-input.jsonl');
    const file = await apiJson('/files', { method: 'POST', formData: form, timeoutMs: 120000 });
    if (!file || !file.id) throw new Error('File upload succeeded but returned no file id; batch job not created.');

    // 2. Create the batch job against the chat completions endpoint.
    let job;
    try {
      job = await apiJson('/batch/jobs', {
        method: 'POST',
        jsonBody: {
          input_files: [file.id],
          endpoint: '/v1/chat/completions',
          model: modelId,
          timeout_hours: timeoutHours,
          metadata: { source: 'mistral-router', requests: String(lines.length) },
        },
        timeoutMs: 60000,
      });
    } catch (err) {
      // Only an HTTP error response proves the server refused the job. On a timeout, abort,
      // network error or unreadable response the job may exist, so the input file is kept.
      if (!err || !err.httpStatus) {
        if (err && typeof err.message === 'string') {
          err.message += ` Job creation outcome is unknown; uploaded input file ${file.id} was NOT deleted because the job may exist. ` +
            'Check the batch job list before deleting it manually.';
        }
        throw err;
      }
      // The job was refused: do not leave the uploaded input file orphaned.
      let cleaned = false;
      try {
        await apiFetch(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', timeoutMs: 30000 });
        cleaned = true;
      } catch { /* reported below */ }
      err.message += cleaned
        ? ` Uploaded input file ${file.id} was deleted (cleanup succeeded).`
        : ` Cleanup FAILED: uploaded input file ${file.id} was not deleted; remove it manually.`;
      throw err;
    }

    return JSON.stringify({
      job_id: job.id,
      status: job.status,
      model: modelId,
      request_count: lines.length,
      input_files: [file.id],
      input_file_id: file.id, // backward compatibility
      timeout_hours: timeoutHours,
      note: 'Async job. Poll with mistral_batch_status, then fetch mistral_batch_results once status is terminal.',
    }, null, 2);
  }

  async function getJob(jobId) {
    if (!jobId || typeof jobId !== 'string') throw new Error('job_id (string) is required.');
    return apiJson(`/batch/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 30000 });
  }

  async function batchStatus(args) {
    const job = await getJob(args.job_id);
    const c = classifyBatchStatus(job.status);
    return JSON.stringify({ ...job, router: { terminal: c.terminal, state: c.kind, note: c.note } }, null, 2);
  }

  async function batchResults(args) {
    const job = await getJob(args.job_id);
    const c = classifyBatchStatus(job.status);
    if (!c.terminal) {
      return JSON.stringify({ job_id: args.job_id, status: job.status, terminal: false, results: [], errors: [], note: c.note }, null, 2);
    }
    const outputId = job.output_file || job.output_file_id || null;
    const errorId = job.error_file || job.error_file_id || null;
    const maxLines = Number.isInteger(args.max_lines) && args.max_lines > 0 ? args.max_lines : 100000;
    const notes = [];
    if (c.kind !== 'success') notes.push(c.note);

    let results = [];
    if (outputId) {
      const parsed = parseJsonl(await apiFetch(`/files/${encodeURIComponent(outputId)}/content`, { timeoutMs: 60000 }), maxLines);
      results = parsed.rows.map(summariseResultRow);
      if (parsed.malformed) notes.push(`${parsed.malformed} malformed output line(s) skipped.`);
      if (parsed.truncated) notes.push(`Output truncated at max_lines=${maxLines}.`);
    } else if (c.kind === 'success' && !errorId) {
      throw new Error(`Job ${args.job_id} reported SUCCESS but has no output file and no error file.`);
    } else {
      notes.push('No output file was produced.');
    }

    let errors = [];
    if (errorId) {
      const parsed = parseJsonl(await apiFetch(`/files/${encodeURIComponent(errorId)}/content`, { timeoutMs: 60000 }), maxLines);
      errors = parsed.rows.map(summariseResultRow).map((r) => ({ custom_id: r.custom_id, status_code: r.status_code, error: r.error }));
      notes.push(`${errors.length} request(s) failed; see errors.`);
    }

    return JSON.stringify({
      job_id: args.job_id,
      status: job.status,
      terminal: true,
      ok: c.kind === 'success' && errors.length === 0,
      job_errors: Array.isArray(job.errors) && job.errors.length ? job.errors : undefined,
      results,
      errors,
      note: notes.join(' ') || undefined,
    }, null, 2);
  }

  async function handleToolCall(name, args) {
    const a = args || {};
    if (name === 'mistral_models') {
      const lines = Object.entries(MODELS).map(([alias, m]) => `- ${alias} -> ${m.id} (${m.label}) — ${m.notes}`);
      return [
        cfg.apiBaseError
          ? `Router model map (endpoint REFUSED: ${cfg.apiBaseError}):`
          : `Router model map (endpoint: ${cfg.apiBase}/chat/completions):`,
        ...lines,
        '',
        'Raw Mistral model IDs (e.g. mistral-large-latest, codestral-latest) are also accepted as "model".',
      ].join('\n');
    }
    if (name === 'mistral_delegate') return callMistral(a);
    if (name === 'mistral_batch_submit') return batchSubmit(a);
    if (name === 'mistral_batch_status') return batchStatus(a);
    if (name === 'mistral_batch_results') return batchResults(a);
    throw new Error(`Unknown tool: ${name}`);
  }

  return { config: cfg, apiFetch, callMistral, batchSubmit, batchStatus, batchResults, handleToolCall };
}

/* ---------- Tool definitions ---------- */

const FILES_DESC =
  'File paths (relative to cwd) to include as context. Sandboxed: must resolve (symlinks included) inside the working directory ' +
  'or MISTRAL_ROUTER_ALLOWED_ROOTS; secrets (.env, keys, .ssh, .git, credentials...) are refused; per-file and file-count caps apply; ' +
  'total context capped by MAX_CONTEXT_CHARS. Any rejected path fails the whole call.';

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
      'Pass repo files via "files" (sandboxed paths relative to the working directory; capped by MAX_CONTEXT_CHARS) and/or inline "context". ' +
      'Set json=true to force a strict JSON response. Returned "content" is the text only (reasoning/thinking blocks are stripped).',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: `Alias: ${Object.keys(MODELS).join(', ')} — or a raw Mistral model ID.`,
        },
        task: { type: 'string', description: 'The full workstream task/instructions for the remote model.' },
        system: { type: 'string', description: 'Optional system prompt override.' },
        files: { type: 'array', items: { type: 'string' }, description: FILES_DESC },
        context: { type: 'string', description: 'Inline context (e.g. diffs, snippets, constraints).' },
        max_tokens: { type: 'integer', description: 'Max output tokens (default 8192).' },
        temperature: { type: 'number', description: 'Sampling temperature in [0, 2] (optional).' },
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
      '(test/doc generation, per-file reviews). The remote model cannot use tools in batch mode. ' +
      'HTTP 402 means an account billing blocker: do not retry.',
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
              files: { type: 'array', items: { type: 'string' }, description: FILES_DESC },
              context: { type: 'string' },
              max_tokens: { type: 'integer' },
              temperature: { type: 'number' },
              json: { type: 'boolean', description: 'Force strict JSON output via response_format.' },
            },
            required: ['task'],
            additionalProperties: false,
          },
        },
        completion_window: { type: 'string', description: 'Batch completion window "<N>h", 1h-168h (default "24h"); sent as timeout_hours.' },
      },
      required: ['model', 'requests'],
      additionalProperties: false,
    },
  },
  {
    name: 'mistral_batch_status',
    description: 'Get the status of a Mistral batch job (GET /v1/batch/jobs/{job_id}), plus router.terminal/state/note.',
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
      'Download and parse a finished batch job output file (and error file, if any). Returns {job_id, status, terminal, ok, results: [{custom_id, status_code, content, usage, error}], errors}. ' +
      'Returns an empty results list with the current status if the job is not in a terminal state yet.',
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

/* ---------- Minimal MCP stdio plumbing (JSON-RPC 2.0, newline-delimited) ---------- */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'mistral-router', version: '0.2.0' };

function createRequestHandler(router, send) {
  const sendResult = (id, result) => send({ jsonrpc: '2.0', id, result });
  const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  return async function handleRequest(req) {
    const { id, method, params } = req;
    switch (method) {
      case 'initialize': {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        sendResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
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
          const text = await router.handleToolCall(params && params.name, params && params.arguments);
          sendResult(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          sendResult(id, { content: [{ type: 'text', text: String((err && err.message) || err) }], isError: true });
        }
        return;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  };
}

function main() {
  const router = createRouter({ warn: (m) => process.stderr.write(`[mistral-router] ${m}\n`) });
  if (router.config.apiBaseError) process.stderr.write(`[mistral-router] ${router.config.apiBaseError}\n`);
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const handleRequest = createRequestHandler(router, send);
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
    if (!msg || msg.id === undefined || msg.id === null) return; // notification: nothing to answer
    handleRequest(msg).catch((err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err.message || err) } }));
  });
}

module.exports = {
  MODELS,
  MODEL_PARAM_POLICIES,
  TOOLS,
  SERVER_INFO,
  BillingBlockedError,
  FileRejectedError,
  resolveModel,
  validateTemperature,
  applyModelParamPolicy,
  extractTextContent,
  validateApiBase,
  canonicalRoots,
  loadConfig,
  sensitiveMatch,
  sensitiveContent,
  unsafeRootReason,
  isPseudoFsPath,
  readCheckedFile,
  resolveSandboxedFile,
  readFileContext,
  buildChatBody,
  classifyBatchStatus,
  parseCompletionWindow,
  validateBatchRequests,
  createRouter,
  createRequestHandler,
  main,
};

if (require.main === module) main();
