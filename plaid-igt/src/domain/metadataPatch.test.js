import { describe, it, expect } from 'vitest';
import { metadataPatchTo, metadataUpdates } from './metadataPatch.js';

// A whole map becomes the patch that writes it. A key the plan dropped must come
// out as an explicit null: the server deletes a key that way and leaves an
// absent one alone, so getting this wrong leaves a sense parented to an entry
// that no longer exists, or a reference pointing at a deleted one.
describe('metadataUpdates', () => {
  const metaById = (entries) => new Map(Object.entries(entries));

  it('sends only the keys that changed', () => {
    const plans = [{ id: 'a', metadata: { gloss: 'cat', pos: 'N' } }];
    expect(metadataUpdates(plans, metaById({ a: { gloss: 'dog', pos: 'N' } }))).toEqual([
      { id: 'a', metadata: { gloss: 'cat' } },
    ]);
  });

  it('nulls a key the plan dropped', () => {
    const plans = [{ id: 'a', metadata: { gloss: 'cat' } }];
    expect(
      metadataUpdates(plans, metaById({ a: { gloss: 'cat', parent: 'b', senseOrder: 2 } })),
    ).toEqual([{ id: 'a', metadata: { parent: null, senseOrder: null } }]);
  });

  it('clears an entry whose map the plan emptied', () => {
    expect(metadataUpdates([{ id: 'a', metadata: {} }], metaById({ a: { parent: 'b' } }))).toEqual([
      { id: 'a', metadata: { parent: null } },
    ]);
  });

  it('adds a key the entry did not have', () => {
    expect(metadataUpdates([{ id: 'a', metadata: { parent: 'b' } }], metaById({ a: {} }))).toEqual([
      { id: 'a', metadata: { parent: 'b' } },
    ]);
  });

  it('drops a plan that changes nothing', () => {
    const plans = [
      { id: 'a', metadata: { gloss: 'cat' } },
      { id: 'b', metadata: { gloss: 'dog' } },
    ];
    expect(metadataUpdates(plans, metaById({ a: { gloss: 'cat' }, b: { gloss: 'cow' } }))).toEqual([
      { id: 'b', metadata: { gloss: 'dog' } },
    ]);
  });

  // A reference list is rebuilt as a new array whichever way it changed, so it
  // is always written: cheap, and never wrong.
  it('writes a rewritten reference list', () => {
    const plans = [{ id: 'a', metadata: { seeAlso: ['x', 'y'] } }];
    expect(metadataUpdates(plans, metaById({ a: { seeAlso: ['x', 'y'] } }))).toEqual([
      { id: 'a', metadata: { seeAlso: ['x', 'y'] } },
    ]);
  });

  it('treats an entry with no metadata at all as empty', () => {
    expect(metadataUpdates([{ id: 'a', metadata: { parent: 'b' } }], new Map())).toEqual([
      { id: 'a', metadata: { parent: 'b' } },
    ]);
  });
});

describe('metadataPatchTo', () => {
  it('is empty when nothing changed', () => {
    expect(metadataPatchTo({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('treats a missing side as empty', () => {
    expect(metadataPatchTo(null, { a: 1 })).toEqual({ a: 1 });
    expect(metadataPatchTo({ a: 1 }, null)).toEqual({ a: null });
    expect(metadataPatchTo(undefined, undefined)).toEqual({});
  });

  // JSON drops an undefined value, so a map that "holds" one would reach the
  // server without the key and the delete would quietly not happen.
  it('counts an undefined value as a key the map does not carry', () => {
    expect(metadataPatchTo({ a: 1 }, { a: undefined })).toEqual({ a: null });
    expect(metadataPatchTo({ a: undefined }, {})).toEqual({});
    expect(metadataPatchTo({}, { a: undefined })).toEqual({});
  });
});
