import { describe, it, expect } from 'vitest';
import {
  argKeyProblem,
  linksUmrProject,
  nextArgKey,
  readArgs,
  readRoleset,
  writeUmr,
} from './vocabUmr.js';

describe('reading an entry’s roleset', () => {
  it('reads the roleset and its arguments, ARG0 first', () => {
    const meta = {
      gloss: 'go away',
      umr: { roleset: 'leave-02', args: { ARG1: 'place', ARG0: 'leaver' } },
    };
    expect(readRoleset(meta)).toBe('leave-02');
    expect(readArgs(meta)).toEqual([
      { key: 'ARG0', description: 'leaver' },
      { key: 'ARG1', description: 'place' },
    ]);
  });

  it('orders by number, so ARG10 follows ARG9 rather than ARG1', () => {
    const meta = { umr: { args: { ARG10: 'tenth', ARG9: 'ninth', ARG1: 'first' } } };
    expect(readArgs(meta).map((a) => a.key)).toEqual(['ARG1', 'ARG9', 'ARG10']);
  });

  it('is empty for an entry with no roleset, which stands for its headword', () => {
    expect(readRoleset({ gloss: 'dog' })).toBe('');
    expect(readArgs({ gloss: 'dog' })).toEqual([]);
    expect(readRoleset(undefined)).toBe('');
  });

  it('ignores a key that is not an argument, and a malformed namespace', () => {
    expect(readArgs({ umr: { args: { ARG0: 'a', note: 'b' } } })).toEqual([
      { key: 'ARG0', description: 'a' },
    ]);
    expect(readArgs({ umr: 'leave-02' })).toEqual([]);
    expect(readRoleset({ umr: ['leave-02'] })).toBe('');
  });
});

describe('writing an entry’s roleset', () => {
  it('writes the roleset and the arguments as a frame file does', () => {
    const out = writeUmr(
      { gloss: 'go away' },
      {
        roleset: ' leave-02 ',
        args: [{ key: 'arg0', description: ' leaver ' }],
      },
    );
    expect(out).toEqual({
      gloss: 'go away',
      umr: { roleset: 'leave-02', args: { ARG0: 'leaver' } },
    });
  });

  it('drops the namespace entirely when nothing is left in it', () => {
    // Not `umr: {}`: cleanMeta keeps an object whatever is inside it, so an
    // emptied roleset would be stored as an entry that had one and lost it.
    const out = writeUmr({ gloss: 'dog', umr: { roleset: 'leave-02' } }, { roleset: '', args: [] });
    expect(out).toEqual({ gloss: 'dog' });
    expect('umr' in out).toBe(false);
  });

  it('keeps anything else under umr, since the namespace is another app’s', () => {
    const out = writeUmr({ umr: { roleset: 'a', somethingElse: 1 } }, { roleset: 'b', args: [] });
    expect(out.umr).toEqual({ somethingElse: 1, roleset: 'b' });
  });

  it('leaves out an argument with no name or a name that is not an ARG', () => {
    const out = writeUmr(
      {},
      {
        roleset: 'leave-02',
        args: [
          { key: 'ARG0', description: 'leaver' },
          { key: '', description: 'nameless' },
          { key: 'Agent', description: 'not an ARG' },
        ],
      },
    );
    expect(out.umr.args).toEqual({ ARG0: 'leaver' });
  });

  it('does not touch the entry’s own fields', () => {
    const fields = { gloss: 'go away', 'Parsing Note': 'check' };
    expect(writeUmr(fields, { roleset: 'leave-02', args: [] })).toMatchObject(fields);
  });
});

describe('argument names', () => {
  it('names the problem with anything that is not ARGn', () => {
    expect(argKeyProblem('ARG0')).toBeNull();
    expect(argKeyProblem('arg12')).toBeNull();
    expect(argKeyProblem('')).toMatch(/needs a name/);
    expect(argKeyProblem('Agent')).toMatch(/ARG0, ARG1/);
  });

  it('proposes the next free one rather than a duplicate', () => {
    expect(nextArgKey([])).toBe('ARG0');
    expect(nextArgKey([{ key: 'ARG0' }, { key: 'arg1' }])).toBe('ARG2');
    expect(nextArgKey([{ key: 'ARG1' }])).toBe('ARG0');
  });
});

describe('whether a vocabulary is linked to a UMR project', () => {
  const umrProject = (vocabId) => ({
    id: 'p-umr',
    vocabs: [{ id: vocabId }],
    textLayers: [
      {
        tokenLayers: [
          { config: { plaid: { role: 'word' } } },
          { config: { umr: { nodes: true } } },
        ],
      },
    ],
  });
  const igtProject = (vocabId) => ({
    id: 'p-igt',
    vocabs: [{ id: vocabId }],
    textLayers: [{ tokenLayers: [{ config: { plaid: { role: 'word' } } }] }],
  });

  it('is true when a project linking it has the UMR node layer', () => {
    expect(linksUmrProject([igtProject('v1'), umrProject('v1')], 'v1')).toBe(true);
  });

  it('is false when the UMR project links a different vocabulary', () => {
    expect(linksUmrProject([umrProject('v2'), igtProject('v1')], 'v1')).toBe(false);
  });

  it('is false for an IGT-only project, and for nothing at all', () => {
    expect(linksUmrProject([igtProject('v1')], 'v1')).toBe(false);
    expect(linksUmrProject([], 'v1')).toBe(false);
    expect(linksUmrProject(undefined, 'v1')).toBe(false);
  });

  // A project set up for UMR is known by its LAYERS. createUmrProject writes
  // no project-level config at all, so a project whose language and gloss
  // lines have never been set still counts.
  it('does not depend on the project carrying any umr config of its own', () => {
    const bare = umrProject('v1');
    expect(bare.config).toBeUndefined();
    expect(linksUmrProject([bare], 'v1')).toBe(true);
  });
});
