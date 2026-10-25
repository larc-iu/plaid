// Every public async method of ConlluDocument is a declared write (WRITES),
// which runs through the guard (`_runWrite`: the project set up for UD, stand-in
// words made or refused), or is listed here as one that needs no guard. A new
// write left off WRITES would write into a project UD has not set up.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';

const EXEMPT = [];

const AsyncFunction = (async () => {}).constructor;

test('every public async method of ConlluDocument is a declared write or exempt', () => {
  const proto = ConlluDocument.prototype;
  const unlisted = Object.getOwnPropertyNames(proto).filter((name) => {
    if (name.startsWith('_') || name === 'constructor') return false;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    return d.value instanceof AsyncFunction && !EXEMPT.includes(name);
  });
  assert.deepEqual(unlisted, []);
  for (const name of ConlluDocument.WRITES) assert.equal(typeof proto[name], 'function', name);
  assert.equal(new Set(ConlluDocument.WRITES).size, ConlluDocument.WRITES.length);
});
