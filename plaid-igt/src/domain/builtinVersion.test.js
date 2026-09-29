import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { builtinDetail } from './builtinVersion.js';
import { SOURCE_TEXTS } from './builtinSourceTexts.js';
import { BUILTIN_ANALYSIS_COPY, BUILTIN_LINK_PRECEDENT } from './serviceDefaults.js';
import { BUILTIN_SOURCES, REPO, manifestHash, readRepoFile } from '../test/builtinHash.js';
import pkg from '../../package.json';

// A built-in rule's version names the code that decides what it writes. That
// is not only the rule's own file: which entry precedent linking picks is
// decided by precedent.js (the tally, pickMajority, not following unverified
// machine choices), what a run does by autoPass.js, and which links it may
// replace by the mutation that writes them. A version that hashed one file
// stayed the same across a change to any of the others.

// Every file of igt and plaid-ui the entries import, followed through
// relative, `@/` and `@ui/` imports. autoPass.js runs both rules, so its own
// text counts for each but its imports are not followed (they would make each
// rule's version the other's too).
const resolveImport = (from, spec) => {
  let base;
  if (spec.startsWith('.')) base = join(dirname(from), spec);
  else if (spec.startsWith('@ui/')) base = join('plaid-ui/src', spec.slice(4));
  else if (spec.startsWith('@/')) base = join('plaid-igt/src', spec.slice(2));
  else return null;
  base = base.replace(/\?.*$/, '');
  const hit = [base, `${base}.js`, `${base}.jsx`, `${base}/index.js`].find((c) =>
    existsSync(join(REPO, c)),
  );
  if (!hit) throw new Error(`${from} imports ${spec}, which does not resolve`);
  return hit;
};

const importClosure = (entries, leaves) => {
  const seen = new Set();
  const todo = [...entries];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (leaves.includes(f)) continue;
    for (const [, spec] of readRepoFile(f).matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const p = resolveImport(f, spec);
      if (p) todo.push(p);
    }
  }
  return [...seen];
};

const D = 'plaid-igt/src/domain/';
// The convention's helpers: the stamp a rule writes, and which links count as
// machine-unverified and so may be replaced.
const PROVENANCE = 'plaid-client-js/src/provenance.js';
const ENTRIES = {
  [BUILTIN_LINK_PRECEDENT]: ['autoLink.js', 'mutations/vocab.js'],
  [BUILTIN_ANALYSIS_COPY]: ['analysisMemory.js', 'mutations/analysisCopy.js'],
};

describe('a built-in rule version', () => {
  it('is kept for exactly the rules that stamp', () => {
    expect(Object.keys(BUILTIN_SOURCES).sort()).toEqual(Object.keys(ENTRIES).sort());
  });

  for (const [name, entries] of Object.entries(ENTRIES)) {
    it(`${name} names every file its writes depend on, in path order`, () => {
      const autoPass = `${D}autoPass.js`;
      const expected = [
        ...importClosure([autoPass, ...entries.map((e) => D + e)], [autoPass]),
        PROVENANCE,
      ].sort();
      expect(BUILTIN_SOURCES[name]).toEqual(expected);
      expect(BUILTIN_SOURCES[name]).toContain(`${D}precedent.js`);
      expect(BUILTIN_SOURCES[name]).toContain(autoPass);
    });

    it(`${name} hashes those files as the documented git show recipe does`, async () => {
      expect(await builtinDetail(name)).toEqual({
        model: `builtin:${name}`,
        version: `${pkg.version}+${manifestHash(BUILTIN_SOURCES[name])}`,
      });
    });
  }

  it('bundles the text of exactly those files, as the repository holds them', () => {
    const paths = [...new Set(Object.values(BUILTIN_SOURCES).flat())].sort();
    expect(Object.keys(SOURCE_TEXTS).sort()).toEqual(paths);
    for (const p of paths) expect(SOURCE_TEXTS[p].replace(/\r\n/g, '\n')).toBe(readRepoFile(p));
  });

  it('is a new version when precedent.js changes, for linking and for copy', () => {
    const changed = (p) =>
      p.endsWith('/precedent.js') ? `${readRepoFile(p)}// changed\n` : readRepoFile(p);
    for (const name of Object.keys(ENTRIES)) {
      const paths = BUILTIN_SOURCES[name];
      expect(manifestHash(paths, changed)).not.toBe(manifestHash(paths));
    }
  });
});
