import { describe, expect, it } from 'vitest';
import {
  announceCells,
  changedTo,
  conflictNoteParts,
  KEPT_IN_CELL,
  recutTo,
} from './cellConflict.js';

describe('conflict toasts', () => {
  it('end with one period', () => {
    expect(changedTo('b', 'NOUN')).toBe('b changed this to NOUN.');
    expect(recutTo('b', 'si')).toBe('b changed this word to si.');
  });

  it('add no second period to a value that already ends a sentence', () => {
    expect(changedTo('b', 'He is tall.')).toBe('b changed this to He is tall.');
    expect(changedTo('b', 'Is he tall?')).toBe('b changed this to Is he tall?');
    expect(recutTo('b', 'We left.', 'sentence')).toBe('b changed this sentence to We left.');
  });

  it('names someone when no user is known, and says cleared for an empty value', () => {
    expect(changedTo(null, 'V')).toBe('Someone changed this to V.');
    expect(changedTo('b', '')).toBe('b cleared this.');
  });
});

describe('announceCells', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const setup = (entries = []) => {
    const said = [];
    const announce = announceCells({
      client: { documents: { auditPage: async () => ({ entries }) } },
      documentId: 'd1',
      me: 'a@b.com',
      warn: (message) => said.push(['warn', message]),
      error: (message, title) => said.push(['error', message, title]),
    });
    return { announce, said };
  };

  it('names who changed a cell to what, once the audit log says who', async () => {
    const { announce, said } = setup([
      { user: { id: 'b@x.com', displayName: 'b' }, ops: [{ description: 'span s1' }] },
    ]);
    announce({ kind: 'conflict', key: 'k', typed: 'x', stored: 'DOG', entityIds: ['s1'] });
    await flush();
    expect(said).toEqual([['warn', 'b changed this to DOG.']]);
  });

  // H10-CONC-1, H11-MULTI-1: a newer change elsewhere (a create whose
  // description names only its layer, a bulk op) is not who changed this cell.
  it('names nobody when no change names the cell, however recent the others', async () => {
    const { announce, said } = setup([
      {
        user: { id: 'c@x.com', displayName: 'c' },
        ops: [{ description: 'Create span in layer L' }],
      },
      { user: { id: 'd@x.com', displayName: 'd' }, ops: [{ description: 'span s9' }] },
    ]);
    announce({ kind: 'conflict', key: 'k', typed: 'x', stored: 'DOG', entityIds: ['s1'] });
    await flush();
    expect(said).toEqual([['warn', 'Someone changed this to DOG.']]);
  });

  it('says You for the same account in another tab, unless someone else wrote since', async () => {
    const mine = { user: { id: 'a@b.com', displayName: 'a' }, ops: [{ description: 'span s1' }] };
    const other = { user: { id: 'c@x.com', displayName: 'c' }, ops: [{ description: 'Bulk' }] };
    const first = setup([mine, other]);
    first.announce({ kind: 'conflict', key: 'k', typed: 'x', stored: 'DOG', entityIds: ['s1'] });
    const second = setup([other, mine]);
    second.announce({ kind: 'conflict', key: 'k', typed: 'x', stored: 'DOG', entityIds: ['s1'] });
    await flush();
    expect(first.said).toEqual([['warn', 'You changed this to DOG.']]);
    expect(second.said).toEqual([['warn', 'Someone changed this to DOG.']]);
  });

  it('names a re-cut word, and says someone when nobody else is in the log', async () => {
    const { announce, said } = setup();
    announce({
      kind: 'conflict',
      key: 'k',
      typed: 'x',
      stored: '',
      recut: { unit: 'morpheme', text: 'si' },
    });
    await flush();
    expect(said).toEqual([['warn', 'Someone changed this morpheme to si.']]);
  });

  // L2-IGT-MULTI-4, REV-R4-IGT R4-1: a Bulk Edit names no row. The change is
  // named only when exactly one person other than this one wrote anything
  // since the document the edit was made on.
  describe('a change that names no row', () => {
    const SINCE = '2026-10-05T01:00:00.5Z';
    const at = (s) => `2026-10-05T01:00:${s}Z`;
    const user = (id) => ({ id, displayName: id.split('@')[0] });
    const bulk = (id, time) => ({
      user: user(id),
      time,
      ops: [
        { type: 'text/update-body', description: 'Update body of text t1' },
        { type: 'token/bulk-update', description: 'Bulk update 26 tokens' },
      ],
    });
    const gloss = (id, span, time) => ({
      user: user(id),
      time,
      ops: [{ type: 'span/update-attributes', description: `Update span ${span}` }],
    });
    const base = { kind: 'conflict', key: 'k', typed: 'canine', stored: '', entityIds: ['w1'] };
    const word = { ...base, recut: { unit: 'word', text: 'kichen', ids: ['w1'] }, since: SINCE };

    it('names the one person who wrote since, past changes of this person', async () => {
      const { announce, said } = setup([
        gloss('a@b.com', 's7', at('09')),
        gloss('c@x.com', 's8', at('08')),
        bulk('c@x.com', at('05')),
        bulk('d@x.com', at('00.400000000')),
      ]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'c changed this word to kichen.']]);
    });

    // R4-1: C's Bulk Edit hit the cell, A's later one did not. Two people
    // wrote since, so nobody is named.
    it('names nobody when two people wrote since, whichever is newer', async () => {
      const { announce, said } = setup([bulk('e@x.com', at('09')), bulk('c@x.com', at('05'))]);
      announce({ ...word, since: SINCE, recut: null, stored: 'kid' });
      await flush();
      expect(said).toEqual([['warn', 'Someone changed this to kid.']]);
    });

    it('names nobody without the time the page held, or when the log page stops short of it', async () => {
      const without = setup([bulk('c@x.com', at('05'))]);
      without.announce({ ...word, since: null });
      const full = Array.from({ length: 50 }, (_, i) => bulk('c@x.com', at(String(10 + i))));
      const short = setup(full);
      short.announce(word);
      await flush();
      expect(without.said).toEqual([['warn', 'Someone changed this word to kichen.']]);
      expect(short.said).toEqual([['warn', 'Someone changed this word to kichen.']]);
    });

    it('names nobody when only this person wrote since', async () => {
      const { announce, said } = setup([bulk('a@b.com', at('05'))]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'Someone changed this word to kichen.']]);
    });

    it('does not take a change the page had already read as the cause', async () => {
      const { announce, said } = setup([
        bulk('c@x.com', at('05')),
        gloss('d@x.com', 'w1', at('00.100')),
      ]);
      announce({ ...word, recut: null, stored: 'DOG' });
      await flush();
      expect(said).toEqual([['warn', 'c changed this to DOG.']]);
    });
  });

  // A repair (kind `repair`) is nobody's change: a conversion run as
  // another account after B's edit leaves B named (FX16-REPAIR).
  it('names the person past a repair that changed the cell after them', async () => {
    const { announce, said } = setup([
      {
        user: { id: 'admin@x.com', displayName: 'admin' },
        kind: 'repair',
        ops: [{ description: 'span s1' }],
      },
      { user: { id: 'b@x.com', displayName: 'b' }, ops: [{ description: 'span s1' }] },
    ]);
    announce({ kind: 'conflict', key: 'k', typed: 'x', stored: 'DOG', entityIds: ['s1'] });
    await flush();
    expect(said).toEqual([['warn', 'b changed this to DOG.']]);
  });

  it('names nobody for a change only a repair made', async () => {
    const SINCE = '2026-10-05T01:00:00.5Z';
    const { announce, said } = setup([
      {
        user: { id: 'admin@x.com', displayName: 'admin' },
        kind: 'repair',
        time: '2026-10-05T01:00:05Z',
        ops: [{ description: 'Bulk update 26 tokens' }],
      },
      { user: { id: 'b@x.com', displayName: 'b' }, time: '2026-10-05T01:00:00Z', ops: [] },
    ]);
    announce({
      kind: 'conflict',
      key: 'k',
      typed: 'x',
      stored: 'DOG',
      entityIds: ['w1'],
      since: SINCE,
    });
    await flush();
    expect(said).toEqual([['warn', 'Someone changed this to DOG.']]);
  });

  it('says a value is kept in its cell, and names one that was lost', () => {
    const { announce, said } = setup();
    announce({ kind: 'keptInCell', key: 'k', field: 'Gloss' });
    announce({ kind: 'lost', key: 'k', typed: 'dog', field: 'Gloss' });
    expect(said).toEqual([
      ['error', KEPT_IN_CELL, 'Failed to update Gloss'],
      ['error', 'Not saved: dog', 'Changed elsewhere'],
    ]);
  });

  it('words the note in three parts', () => {
    expect(conflictNoteParts('hound')).toEqual({
      before: 'Yours: ',
      value: 'hound',
      after: ' · Enter to keep yours',
    });
    expect(conflictNoteParts('').value).toBe('(none)');
  });
});
