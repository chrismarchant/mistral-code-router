'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, readFileContext, resolveSandboxedFile, sensitiveMatch, createRouter } = require('../server.js');
const { mkRoot, write, fakeFetch, ENV } = require('./helpers.js');

function setup(env = {}) {
  const { parent, root } = mkRoot();
  const cfg = loadConfig({ ...ENV, ...env }, root);
  return { parent, root, cfg };
}

function rejects(fn, given, reason) {
  assert.throws(fn, (err) => {
    assert.ok(err.message.includes(`${JSON.stringify(given)} -> ${reason}`), err.message);
    return true;
  });
}

test('file inside root is read', () => {
  const { root, cfg } = setup();
  write(path.join(root, 'src/a.js'), 'const a = 1;\n');
  const out = readFileContext(['src/a.js'], cfg);
  assert.match(out, /^<(file-[0-9a-f]{12}) path="src\/a.js">\nconst a = 1;\n\n<\/\1>$/);
  // absolute path inside root also fine
  assert.match(readFileContext([path.join(root, 'src/a.js')], cfg), /const a = 1/);
});

test('../ traversal is rejected as outside_root', () => {
  const { parent, root, cfg } = setup();
  write(path.join(parent, 'outside.txt'), 'nope');
  rejects(() => readFileContext(['../outside.txt'], cfg), '../outside.txt', 'outside_root');
  rejects(() => readFileContext(['src/../../outside.txt'], cfg), 'src/../../outside.txt', 'outside_root');
  rejects(() => readFileContext(['../missing.txt'], cfg), '../missing.txt', 'outside_root');
  assert.ok(root);
});

test('absolute path outside root is rejected', () => {
  const { parent, cfg } = setup();
  const p = write(path.join(parent, 'abs.txt'));
  rejects(() => readFileContext([p], cfg), p, 'outside_root');
  rejects(() => readFileContext(['/etc/passwd'], cfg), '/etc/passwd', 'outside_root');
});

test('symlink inside root pointing outside is rejected as symlink_escape', () => {
  const { parent, root, cfg } = setup();
  const target = write(path.join(parent, 'secret.txt'), 'outside data');
  fs.symlinkSync(target, path.join(root, 'link.txt'));
  fs.symlinkSync(parent, path.join(root, 'dirlink'));
  rejects(() => readFileContext(['link.txt'], cfg), 'link.txt', 'symlink_escape');
  rejects(() => readFileContext(['dirlink/secret.txt'], cfg), 'dirlink/secret.txt', 'symlink_escape');
});

test('symlink inside root pointing inside root is allowed', () => {
  const { root, cfg } = setup();
  write(path.join(root, 'real.txt'), 'inside data');
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
  assert.match(readFileContext(['alias.txt'], cfg), /inside data/);
});

test('sibling directory with root as a name prefix is rejected', () => {
  const { parent, cfg } = setup();
  const evil = write(path.join(parent, 'root-evil', 'x.txt'), 'evil');
  rejects(() => readFileContext([evil], cfg), evil, 'outside_root');
  rejects(() => readFileContext(['../root-evil/x.txt'], cfg), '../root-evil/x.txt', 'outside_root');
});

test('directories and missing files are rejected', () => {
  const { root, cfg } = setup();
  fs.mkdirSync(path.join(root, 'dir'));
  rejects(() => readFileContext(['dir'], cfg), 'dir', 'not_regular_file');
  rejects(() => readFileContext(['.'], cfg), '.', 'not_regular_file');
  rejects(() => readFileContext(['nope.txt'], cfg), 'nope.txt', 'not_found');
});

test('FIFO is rejected as not_regular_file', { skip: process.platform === 'win32' }, () => {
  const { root, cfg } = setup();
  const { execFileSync } = require('node:child_process');
  try { execFileSync('mkfifo', [path.join(root, 'pipe')]); } catch { return; }
  rejects(() => readFileContext(['pipe'], cfg), 'pipe', 'not_regular_file');
});

test('each sensitive class is rejected', () => {
  const { root, cfg } = setup();
  const files = [
    '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519.pub', 'x.pem', 'server.key', 'cert.p12', 'a.pfx',
    'store.jks', 'my.keystore', '.ssh/config', '.git/config', '.git/HEAD', '.aws/credentials', '.gnupg/pubring.kbx',
    '.netrc', '.npmrc', '.pypirc', '.docker/config.json', '.kube/config', 'credentials', 'config/credentials.json',
    'secrets.yaml', 'infra/prod.tfstate', 'infra/prod.tfvars', '.claude/settings.local.json', 'pkg/settings.local.json',
    '.claude.json', 'sub/.ENV',
  ];
  for (const f of files) {
    write(path.join(root, f), 'harmless');
    rejects(() => readFileContext([f], cfg), f, 'sensitive');
  }
});

test('allowed env templates and look-alikes are not sensitive', () => {
  const { root, cfg } = setup();
  for (const f of ['.env.example', '.env.sample', '.env.template', '.gitignore', 'environment.js', 'docker/config.json', 'keys.md']) {
    write(path.join(root, f), `ok ${f}`);
    assert.match(readFileContext([f], cfg), new RegExp(`ok ${f.replace(/\./g, '\\.')}`));
  }
  assert.strictEqual(sensitiveMatch('src/app.js'), null);
});

test('symlink with innocent name pointing to a sensitive file inside root is rejected', () => {
  const { root, cfg } = setup();
  write(path.join(root, '.env'), 'TOKEN=x');
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
  rejects(() => readFileContext(['notes.txt'], cfg), 'notes.txt', 'sensitive');
});

test('PEM private key content is rejected without leaking content', () => {
  const { root, cfg } = setup();
  write(path.join(root, 'notes.md'), 'intro\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAASECRETMATERIAL' + 'b3BlbnNzaC1rZXk'.repeat(4) + '\n-----END OPENSSH PRIVATE KEY-----\n');
  write(path.join(root, 'rsa.txt'), '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIE'.repeat(16) + '\n');
  assert.throws(() => readFileContext(['notes.md'], cfg), (err) => {
    assert.match(err.message, /"notes\.md" -> sensitive \(contains a PEM\/PGP private key\)/);
    assert.ok(!err.message.includes('SECRETMATERIAL'));
    return true;
  });
  rejects(() => readFileContext(['rsa.txt'], cfg), 'rsa.txt', 'sensitive');
  write(path.join(root, 'pub.txt'), '-----BEGIN PUBLIC KEY-----\nabc\n');
  assert.match(readFileContext(['pub.txt'], cfg), /PUBLIC KEY/);
});

test('per-file byte cap (env overridable)', () => {
  const { root, cfg } = setup({ MISTRAL_ROUTER_MAX_FILE_BYTES: '100' });
  assert.strictEqual(cfg.maxFileBytes, 100);
  write(path.join(root, 'big.txt'), 'x'.repeat(101));
  write(path.join(root, 'ok.txt'), 'x'.repeat(100));
  rejects(() => readFileContext(['big.txt'], cfg), 'big.txt', 'too_large');
  assert.ok(readFileContext(['ok.txt'], cfg).includes('x'.repeat(100)));
  assert.strictEqual(setup().cfg.maxFileBytes, 512 * 1024);
});

test('file-count cap', () => {
  const { root, cfg } = setup({ MISTRAL_ROUTER_MAX_FILES: '2' });
  write(path.join(root, 'a.txt'));
  assert.throws(() => readFileContext(['a.txt', 'a.txt', 'a.txt'], cfg), /3 files requested > cap 2.*too_many_files/);
  assert.strictEqual(setup().cfg.maxFiles, 50);
});

test('total context cap truncates and omits later files (but still validates them)', () => {
  const { root, cfg } = setup({ MAX_CONTEXT_CHARS: '10' });
  write(path.join(root, 'a.txt'), 'AAAAAAAA');
  write(path.join(root, 'b.txt'), 'BBBBBBBB');
  write(path.join(root, 'c.txt'), 'CCCCCCCC');
  const out = readFileContext(['a.txt', 'b.txt', 'c.txt'], cfg);
  assert.match(out, /AAAAAAAA/);
  assert.match(out, /BB\n\.\.\. \[truncated by MAX_CONTEXT_CHARS\]/);
  assert.match(out, /<file-[0-9a-f]{12} path="c.txt" omitted="MAX_CONTEXT_CHARS reached" \/>/);
  assert.ok(!out.includes('CCC'));
  write(path.join(root, '.env'), 'X=1');
  rejects(() => readFileContext(['a.txt', 'b.txt', '.env'], cfg), '.env', 'sensitive');
});

test('any rejected path fails the whole call and lists every rejection', () => {
  const { root, cfg } = setup();
  write(path.join(root, 'a.txt'), 'fine');
  write(path.join(root, '.env'), 'X=1');
  assert.throws(() => readFileContext(['a.txt', '.env', '../x', 'missing'], cfg), (err) => {
    assert.match(err.message, /^File context rejected \(no request sent\)/);
    assert.match(err.message, /"\.env" -> sensitive/);
    assert.match(err.message, /"\.\.\/x" -> outside_root/);
    assert.match(err.message, /"missing" -> not_found/);
    assert.ok(!err.message.includes('fine'));
    return true;
  });
});

test('extra root via MISTRAL_ROUTER_ALLOWED_ROOTS works; others stay blocked', () => {
  const { parent: p2, root: extra } = mkRoot();
  write(path.join(extra, 'shared.txt'), 'shared data');
  write(path.join(p2, 'outside.txt'), 'no');
  const { cfg } = setup({ MISTRAL_ROUTER_ALLOWED_ROOTS: [extra, '/definitely/not/here'].join(path.delimiter) });
  assert.strictEqual(cfg.roots.length, 2);
  assert.match(readFileContext([path.join(extra, 'shared.txt')], cfg), /shared data/);
  rejects(() => readFileContext([path.join(p2, 'outside.txt')], cfg), path.join(p2, 'outside.txt'), 'outside_root');
  const { cfg: noExtra } = setup();
  rejects(() => readFileContext([path.join(extra, 'shared.txt')], noExtra), path.join(extra, 'shared.txt'), 'outside_root');
});

test('non-array files and bad entries are rejected', () => {
  const { cfg } = setup();
  assert.throws(() => readFileContext('a.txt', cfg), /files must be an array/);
  assert.throws(() => resolveSandboxedFile('', cfg), /not_found/);
  assert.throws(() => resolveSandboxedFile('a\0b', cfg), /not_found/);
  assert.strictEqual(readFileContext([], cfg), '');
  assert.strictEqual(readFileContext(undefined, cfg), '');
});

test('delegate with a rejected file sends no request', async () => {
  const { root } = mkRoot();
  write(path.join(root, '.env'), 'X=1');
  const fetch = fakeFetch([]);
  const r = createRouter({ env: ENV, cwd: root, fetch });
  await assert.rejects(r.callMistral({ model: 'glm', task: 't', files: ['.env'] }), /sensitive/);
  assert.strictEqual(fetch.calls.length, 0);
});
