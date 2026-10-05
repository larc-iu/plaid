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

  // L2-IGT-MULTI-4: a Bulk Edit respell names no word, but it is who changed
  // this one when nobody but its author (and this person) wrote since.
  describe('a change that names no row', () => {
    const user = (id) => ({ id, displayName: id.split('@')[0] });
    const bulk = (id) => ({
      user: user(id),
      kind: 'bulk-edit',
      ops: [
        { type: 'text/update-body', description: 'Update body of text t1' },
        { type: 'token/bulk-update', description: 'Bulk update 26 tokens' },
      ],
    });
    const gloss = (id, span) => ({
      user: user(id),
      ops: [{ type: 'span/update-attributes', description: `Update span ${span}` }],
    });
    const base = { kind: 'conflict', key: 'k', typed: 'canine', stored: '', entityIds: ['w1'] };
    const word = { ...base, recut: { unit: 'word', text: 'kichen', ids: ['w1'] } };

    it('names the author of the newest bulk change', async () => {
      const { announce, said } = setup([bulk('c@x.com')]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'c changed this word to kichen.']]);
    });

    it('still names them past later changes of their own and of this person', async () => {
      const { announce, said } = setup([
        gloss('a@b.com', 's7'),
        gloss('c@x.com', 's8'),
        bulk('c@x.com'),
      ]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'c changed this word to kichen.']]);
    });

    it('names nobody once someone else wrote since', async () => {
      const { announce, said } = setup([gloss('d@x.com', 's9'), bulk('c@x.com')]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'Someone changed this word to kichen.']]);
    });

    it('takes the type with or without its namespace, and a restore or a text edit', async () => {
      for (const type of ['bulk-update', 'update-body', 'document/restore']) {
        const { announce, said } = setup([{ user: user('c@x.com'), ops: [{ type }] }]);
        announce(word);
        await flush();
        expect(said).toEqual([['warn', 'c changed this word to kichen.']]);
      }
    });

    it('says You for a bulk change from this account, with nobody else since', async () => {
      const { announce, said } = setup([bulk('a@b.com')]);
      announce(word);
      await flush();
      expect(said).toEqual([['warn', 'You changed this word to kichen.']]);
    });
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
