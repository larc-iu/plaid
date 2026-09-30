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
