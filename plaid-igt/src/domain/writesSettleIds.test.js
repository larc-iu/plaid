// A write takes the ids it is handed settled (DocumentModel `_runWrite`). The
// screen can still hold the id a row was shown under before its create
// answered (a selected word), and a write called with it must name the row
// the server made.
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRawDoc, makeFakeClient, makeIgtDoc, resetIds } from './test-helpers.js';
import { isPendingId } from '@ui/domain/pendingIds.js';

beforeEach(() => resetIds());

describe('a write handed an id from before its create answered', () => {
  it('names the row the server made', async () => {
    const client = makeFakeClient();
    const doc = makeIgtDoc({
      raw: buildRawDoc({ words: [{ id: 'w-1', begin: 0, end: 3 }] }),
      client,
    });
    const made = doc.createToken(4, 7);
    const shownAs = doc.layerInfo.primaryTokenLayer.tokens.find((t) => t.begin === 4).id;
    expect(isPendingId(shownAs)).toBe(true);
    expect(await made).toBe(true);

    const serverId = doc.layerInfo.primaryTokenLayer.tokens.find((t) => t.begin === 4).id;
    expect(serverId).not.toBe(shownAs);

    expect(await doc.deleteToken(shownAs)).toBe(true);
    const deletes = client.calls.filter((c) => c.kind === 'tokens.delete');
    expect(deletes.map((c) => c.args[0])).toEqual([serverId]);
    expect(doc.layerInfo.primaryTokenLayer.tokens.map((t) => t.id)).toEqual(['w-1']);
  });
});
