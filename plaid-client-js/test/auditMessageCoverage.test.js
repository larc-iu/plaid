// Coverage guard: EVERY write method (POST/PUT/PATCH/DELETE) on the CRUD
// bundles must thread its trailing `auditMessage` argument into the request
// URL as `?audit-message=`. Auto-discovers methods via a stubbed fetch, so a
// new write method added without the param will fail this test.

import { test } from 'node:test';
import assert from 'node:assert';
import { PlaidClient } from '../src/index.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// How many arguments come before `auditMessage`, for methods where `fn.length`
// cannot say. A parameter with a default stops the count, so
// `restore(documentId, asOf, { dryRun } = {}, auditMessage)` reports 2 and the
// probe would otherwise put its sentinel in `asOf` and report a false failure.
const ARGS_BEFORE_AUDIT_MESSAGE = {
  'documents.restore': 3,
  'documents.copy': 3,
};
// CRUD bundles whose writes hit document state. `messages`/services are
// real-time/registry (not audit-logged) and use streaming transports.
const BUNDLES = [
  'vocabLinks', 'vocabLayers', 'relations', 'spanLayers', 'spans', 'batch',
  'texts', 'users', 'apiTokens', 'tokenLayers', 'documents', 'projects',
  'textLayers', 'vocabItems', 'relationLayers', 'tokens',
];

test('every CRUD write method threads a per-call auditMessage', async () => {
  process.on('unhandledRejection', () => {});
  const client = new PlaidClient('http://x', 'tok');
  let lastCall = null;
  globalThis.fetch = async (url, opts) => {
    lastCall = { url, method: opts.method };
    return {
      ok: true, status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const SENT = 'COVPROBE';
  const checked = [];
  const probe = async (label, fn) => {
    const before = ARGS_BEFORE_AUDIT_MESSAGE[label] ?? Math.max(fn.length - 1, 0);
    const args = Array(before).fill('x');
    args.push(SENT);
    lastCall = null;
    try { await fn(...args); } catch { return; } // GET pagination chokes on the stub — skip
    if (lastCall && WRITE.has(lastCall.method)) {
      checked.push(label);
      assert.ok(lastCall.url.includes(`audit-message=${SENT}`),
        `${label} (${lastCall.method}) did not thread auditMessage: ${lastCall.url}`);
    }
  };
  for (const b of BUNDLES) {
    const bundle = client[b];
    if (!bundle) continue;
    for (const [m, fn] of Object.entries(bundle)) {
      if (typeof fn === 'function') await probe(`${b}.${m}`, fn);
    }
  }
  await probe('query', client.query);
  assert.ok(checked.length >= 105, `expected ~109 write methods, only checked ${checked.length}`);
});
