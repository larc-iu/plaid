import { describe, it, expect, afterEach } from 'vitest';
import { PlaidClient } from '../../../plaid-client-js/src/index.js';
import { DocumentModel } from './DocumentModel.js';

// A copy of a document with a recording, over the real client, against a
// fetch that answers as plaid-core does: a keyed copy answers `{id, name}`
// with no word of a recording it could not copy, and a resend of the same key
// is answered from what was stored. The page reads the copy to know (H2-6-1).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function server({ copied, loseFirst = false }) {
  const state = { copies: 0, keys: [], stored: new Map(), lose: loseFirst ? 1 : 0, reads: [] };
  const answer = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (opts.method === 'GET') {
      state.reads.push(u.pathname + u.search);
      return answer(200, {
        'document/id': 'd2',
        'document/name': 'One (copy)',
        ...(copied ? { 'document/media-url': '/api/v1/documents/d2/media?v=1-5' } : {}),
      });
    }
    const key = opts.headers?.['Idempotency-Key'];
    state.keys.push(key);
    if (key && state.stored.has(key)) return answer(201, state.stored.get(key));
    state.copies += 1;
    const body = { id: 'd2', name: 'One (copy)' };
    state.stored.set(key, body);
    if (state.lose > 0) {
      state.lose -= 1;
      throw new TypeError('Failed to fetch');
    }
    return answer(201, body);
  };
  return state;
}

const open = () => {
  const client = new PlaidClient('http://x', 'tok', { retryDelaysMs: [] });
  const doc = new DocumentModel({
    raw: { id: 'd1', name: 'One', metadata: {}, mediaUrl: '/api/v1/documents/d1/media?v=1-5' },
    client,
  });
  doc._writes._retryDelay = () => 0;
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, errors };
};

describe('a copy of a document with a recording (H2-6-1)', () => {
  it('says the recording was not copied, after a resend answered from its key', async () => {
    const state = server({ copied: false, loseFirst: true });
    const { doc, errors } = open();
    const created = await doc.copyTo('One (copy)');
    // One copy made, its answer lost and given again under the same key.
    expect(state.copies).toBe(1);
    expect(state.keys).toHaveLength(2);
    expect(state.keys[0]).toBe(state.keys[1]);
    expect(created).toMatchObject({ id: 'd2', mediaError: 'The recording was not copied.' });
    expect(state.reads).toEqual(['/api/v1/documents/d2']);
    expect(errors).toEqual([]);
  });

  it('says nothing when the copy has its recording', async () => {
    server({ copied: true });
    const { doc } = open();
    const created = await doc.copyTo('One (copy)');
    expect(created).toEqual({ id: 'd2', name: 'One (copy)' });
  });
});
