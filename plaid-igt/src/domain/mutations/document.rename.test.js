import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '../test-helpers.js';

// The Details tab's save writes the name the way the shared `rename` does:
// trimmed, and never blank. One rule for every writer of a document's name.

const makeDoc = () =>
  new IgtDocument({
    raw: buildRawDoc({ metadata: {} }),
    project: {
      id: 'proj-1',
      vocabs: [],
      config: { igt: { documentMetadata: [{ name: 'Date' }] } },
    },
    vocabularies: {},
    client: makeFakeClient(),
    projectId: 'proj-1',
  });

const updates = (doc) => doc.client.calls.filter((c) => c.kind === 'documents.update');

describe('saveNameAndMetadata writes the name as rename does', () => {
  it('trims the name it writes and shows', async () => {
    const doc = makeDoc();
    expect(await doc.saveNameAndMetadata('  New Name  ', {})).toBe(true);
    expect(updates(doc).map((c) => c.args[1])).toEqual(['New Name']);
    expect(doc.name).toBe('New Name');
  });

  it('leaves the name alone when it is blank or only its spaces changed', async () => {
    const doc = makeDoc();
    const name = doc.name;
    expect(await doc.saveNameAndMetadata('   ', { Date: 'q' })).toBe(true);
    expect(await doc.saveNameAndMetadata(` ${name} `, {})).toBe(true);
    expect(updates(doc)).toEqual([]);
    expect(doc.name).toBe(name);
  });

  it('agrees with rename on every name', async () => {
    for (const typed of ['  a  ', '', ' ', 'Test Doc', ' Test Doc', 'b']) {
      const viaSave = makeDoc();
      const viaRename = makeDoc();
      await viaSave.saveNameAndMetadata(typed, {});
      await viaRename.rename(typed);
      expect(viaSave.name).toBe(viaRename.name);
      expect(updates(viaSave).map((c) => c.args[1])).toEqual(
        updates(viaRename).map((c) => c.args[1]),
      );
    }
  });
});
