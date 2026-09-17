// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient } from '@/domain/test-helpers.js';

// jsdom, not the happy-dom the rest of the suite runs in. Its HTML parser
// follows the spec, as a browser's does, and happy-dom's does not: a stray
// quote after an unquoted attribute binding once landed inside the style
// value here, where only a spec parser rejects the declaration.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const VOCAB = {
  id: 'v1',
  name: 'Lexicon',
  config: { igt: { fields: { gloss: { inline: true } } } },
  items: [
    { id: 'h', form: 'kat', metadata: { gloss: 'cat' } },
    { id: 's', form: 'kat', metadata: { gloss: 'lion', parent: 'h', senseOrder: 1 } },
  ],
};

let host;
afterEach(() => {
  host?.remove();
  host = null;
});

describe('the popover entry list', () => {
  it('indents a sense under the headword it is listed with', () => {
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = new IgtDocument({
      raw: buildRawDoc({ body: 'the kat' }),
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {}, igt: {} } },
      vocabularies: { v1: structuredClone(VOCAB) },
      client,
      projectId: 'proj-1',
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    new IgtEditor(host, doc, {});
    const opener = [...host.querySelectorAll('.igt-vocab__opener')].at(-1);
    opener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const rows = [...host.querySelectorAll('.igt-vocab-pop__item')];
    const head = rows.find((r) => r.textContent.includes('cat'));
    const sense = rows.find((r) => r.textContent.includes('lion'));
    expect(head).toBeTruthy();
    expect(sense).toBeTruthy();
    // Grouping the list by headword only reads as grouping if a sense indents.
    expect(head.style.marginLeft).toBe('');
    expect(sense.style.marginLeft).toBe('14px');
  });
});

// "Link every…" on the first click: before the token has a link, the
// highlighted row offers to take the other unlinked tokens reading the same.
describe('taking every same-form token along with the first link', () => {
  const open = (body) => {
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const doc = new IgtDocument({
      raw: buildRawDoc({
        body,
        words: body.split(' ').map((w, i) => ({ id: `w-${i + 1}`, begin: i * 4, end: i * 4 + 3 })),
      }),
      project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {}, igt: {} } },
      vocabularies: { v1: structuredClone(VOCAB) },
      client,
      projectId: 'proj-1',
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    new IgtEditor(host, doc, {});
    // The first WORD-level opener, on the first "kat".
    host
      .querySelector('.igt-vocab__opener')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { doc, client };
  };
  const linkedForms = (doc) => doc.sentences[0].tokens.map((t) => t.vocabItem?.id ?? null);

  it('offers the chip on the highlighted row, counting this token too', () => {
    open('kat kat kat');
    const chips = [...host.querySelectorAll('.igt-vocab-pop__item .igt-vocab-pop__take-all')];
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent.trim()).toBe('all ×3');
  });

  it('offers nothing when no other token reads the same', () => {
    open('the kat');
    expect(host.querySelector('.igt-vocab-pop__take-all')).toBeNull();
  });

  it('links them all from the chip, and only this one from the row', async () => {
    const { doc } = open('kat kat kat');
    host
      .querySelector('.igt-vocab-pop__item .igt-vocab-pop__take-all')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(linkedForms(doc).filter(Boolean)).toHaveLength(3));
    expect(new Set(linkedForms(doc)).size).toBe(1);
  });

  it('links them all on Shift+click of the row, and one on a plain click', async () => {
    const click = (init) =>
      host
        .querySelector('.igt-vocab-pop__item')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    const { doc } = open('kat kat kat');
    click({ shiftKey: true });
    await vi.waitFor(() => expect(linkedForms(doc).filter(Boolean)).toHaveLength(3));

    host.remove();
    const second = open('kat kat kat');
    click({});
    await vi.waitFor(() => expect(linkedForms(second.doc).filter(Boolean)).toHaveLength(1));
  });

  it('links them all on Shift+Enter, and one on Enter', async () => {
    const { doc } = open('kat kat kat');
    const key = (init) =>
      host
        .querySelector('.igt-vocab-pop__search')
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    key({ key: 'Enter', shiftKey: true });
    await vi.waitFor(() => expect(linkedForms(doc).filter(Boolean)).toHaveLength(3));

    host.remove();
    const second = open('kat kat kat');
    key({ key: 'Enter' });
    await vi.waitFor(() => expect(linkedForms(second.doc).filter(Boolean)).toHaveLength(1));
  });
});
