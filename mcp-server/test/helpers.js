'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Create a temp workspace root; returns its canonical path. */
function mkRoot(prefix = 'mcr-') {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const root = path.join(parent, 'root');
  fs.mkdirSync(root);
  return { parent, root };
}

function write(p, content = 'hello\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/**
 * Fake fetch. routes: array of { method, match: (url) => bool, status, body } (body string or object),
 * consumed in order of first match. Records calls (no headers retained beyond presence of Authorization).
 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body, hasAuth: Boolean(init.headers && init.headers.Authorization), redirect: init.redirect });
    const route = routes.find((r) => (r.method || 'GET') === method && r.match(url));
    if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
    const status = route.status || 200;
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body || {});
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const ENV = { MISTRAL_API_KEY: 'dummy-test-key' };

module.exports = { mkRoot, write, fakeFetch, ENV };
