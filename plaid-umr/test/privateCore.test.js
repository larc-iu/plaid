// When the e2e fixture may delete and rebuild a project: only on a core the
// round runner started for this run. The shared dev core on :8085 is Luke's,
// and it answers on other ports too, through each app's dev proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateCore } from '../e2e/privateCore.js';

const RUNNER = 'http://127.0.0.1:8303';

test('a request the runner routed to its own core is private', () => {
  assert.equal(isPrivateCore('http://127.0.0.1:8303/api/v1/projects', RUNNER), true);
});

test('the shared dev core is never private, however it is spelled', () => {
  for (const url of [
    'http://localhost:8085/api/v1/projects',
    'http://127.0.0.1:8085/api/v1/projects',
    'http://[::1]:8085/api/v1/projects',
    'http://0.0.0.0:08085/api/v1/projects',
  ]) {
    assert.equal(isPrivateCore(url, url), false, url);
    assert.equal(isPrivateCore(url, undefined), false, url);
  }
});

test("an app's dev server, which passes /api on to the shared dev core, is not private", () => {
  for (const port of ['5173', '5174', '5175', '5176']) {
    const url = `http://localhost:${port}/api/v1/projects`;
    assert.equal(isPrivateCore(url, `http://localhost:${port}`), false, port);
  }
});

test('a URL with no port is not private: a proxy in front of a core names none', () => {
  assert.equal(isPrivateCore('http://larc/api/v1/projects', 'http://larc'), false);
  assert.equal(
    isPrivateCore('https://plaid.example.org/api/v1/projects', 'https://plaid.example.org'),
    false,
  );
});

test('a request that did not reach the core the runner named is not private', () => {
  // No runner at all: some other shim, or none.
  assert.equal(isPrivateCore('http://127.0.0.1:8303/api/v1/projects', undefined), false);
  assert.equal(isPrivateCore('http://127.0.0.1:8303/api/v1/projects', ''), false);
  // Routed somewhere other than where the runner said.
  assert.equal(isPrivateCore('http://127.0.0.1:9999/api/v1/projects', RUNNER), false);
  // A response whose URL a mock left empty, or a runner URL that is not one.
  assert.equal(isPrivateCore('', RUNNER), false);
  assert.equal(isPrivateCore('http://127.0.0.1:8303/', 'not a url'), false);
});
