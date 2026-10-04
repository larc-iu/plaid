// A Baseline save that landed with its answer lost, whose resend is then
// refused (a 403 or 500 that never reached the server, or a 422 because
// someone else saved over it): the text stored holds the save, so the edits
// never come back into the draft (G1-gap, third review). A real IgtDocument
// against a server that keeps what it stores.
import { expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { useBaselineOperations } from './useBaselineOperations.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc as buildDoc, resetIds } from '@/domain/test-helpers.js';

// These tests are of the edit's own send: "Tokenize new text" is off, so
// typing adds no words (newTextWords and its batch have tests of their own).
const buildRawDoc = (opts) => {
  const raw = buildDoc(opts);
  const words = raw.textLayers[0].tokenLayers.find((l) => l.id === 'wordL');
  words.config.igt.tokenizeNewText = false;
  return raw;
};
import { segmentServer } from '@/test/segmentServer.js';

const toasts = vi.hoisted(() => ({ list: [] }));
vi.mock('@/utils/feedback', async (orig) => ({
  ...(await orig()),
  notifySuccess: (m) => toasts.list.push(`ok:${m}`),
  notifyError: (m, t) => toasts.list.push(`err:${t}:${m}`),
  notifyWarning: (m) => toasts.list.push(`warn:${m}`),
}));

beforeEach(() => {
  resetIds();
  toasts.list = [];
});

const open = (server) => {
  const doc = new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });
  doc._writes._retryDelay = () => 5;
  doc.onError = () => {};
  return doc;
};

// The box put at `next`, as typed with the caret at `caret`, from a selection
// [s, e) before the change.
const change = async (h, next, s, e, caret) => {
  await act(async () =>
    h.api.editLogHandlers.onKeyDown({ target: { selectionStart: s, selectionEnd: e } }),
  );
  await act(async () =>
    h.api.handleTextChange({ target: { value: next, selectionStart: caret, selectionEnd: caret } }),
  );
};

const settle = () => new Promise((r) => setTimeout(r, 20));
const refusal = (status, data) =>
  Object.assign(new Error(`HTTP ${status}`), { status, method: 'PATCH', responseData: data });

// The first send stored with its answer lost, then `between(server)`, then
// the resend refused with `refuse`.
async function saveResentAndRefused({ body, typed, during = [], between, refuse }) {
  const server = segmentServer(
    buildRawDoc({
      body,
      words: [],
      morphemes: [],
      sentences: [{ id: 's-1', begin: 0, end: [...body].length }],
    }),
  );
  const doc = open(server);
  const h = await mountDocumentHook(useBaselineOperations, { doc });
  await act(async () => h.api.handleEdit());
  await change(h, ...typed);
  server.loseNext(1);
  const edit = server.client.texts.edit;
  let calls = 0;
  server.client.texts.edit = async (...args) => {
    calls += 1;
    if (calls === 2) {
      between?.(server);
      throw refuse;
    }
    return edit(...args);
  };
  let saved;
  await act(async () => {
    saved = h.api.handleSave();
  });
  for (const d of during) await change(h, ...d);
  await act(async () => {
    await saved;
    await settle();
  });
  while (doc.isSaving) await act(settle);
  return { h, server };
}

for (const status of [403, 500]) {
  it(`a resend refused ${status}: the box closes over the text stored`, async () => {
    const { h, server } = await saveResentAndRefused({
      body: 'the cat sat',
      typed: ['the big cat sat', 3, 3, 7],
      refuse: refusal(status),
    });
    expect(server.body).toBe('the big cat sat');
    expect(h.api.isEditing).toBe(false);
    expect(h.api.changedElsewhere).toBe(false);
    expect(hasUnsavedDraft()).toBe(null);
    h.unmount();
  });
}

it('a resend refused 500 with text typed since: only that text is left to save', async () => {
  const { h, server } = await saveResentAndRefused({
    body: 'the cat sat on the mat',
    typed: ['the big cat sat on the mat', 3, 3, 7],
    during: [['the big cat sat on the mat!', 26, 26, 27]],
    refuse: refusal(500),
  });
  expect(server.body).toBe('the big cat sat on the mat');
  expect(h.api.isEditing).toBe(true);
  expect(h.api.editedText).toBe('the big cat sat on the mat!');
  expect(h.api.changedElsewhere).toBe(false);
  await act(async () => {
    await h.api.handleSave();
    await settle();
  });
  expect(server.body).toBe('the big cat sat on the mat!');
  expect(h.api.isEditing).toBe(false);
  h.unmount();
});

it('a resend refused 422 after someone else saved elsewhere: the box closes over both', async () => {
  const { h, server } = await saveResentAndRefused({
    body: 'the cat sat on a mat',
    typed: ['the big cat sat on a mat', 3, 3, 7],
    between: (s) =>
      s.otherSaves([
        { type: 'delete', index: 21, value: 3 },
        { type: 'insert', index: 21, value: 'rug' },
      ]),
    refuse: refusal(422, { error: 'idempotency-key-reused' }),
  });
  expect(server.body).toBe('the big cat sat on a rug');
  expect(h.api.isEditing).toBe(false);
  expect(toasts.list.filter((t) => t.startsWith('err:'))).toEqual([]);
  h.unmount();
});
