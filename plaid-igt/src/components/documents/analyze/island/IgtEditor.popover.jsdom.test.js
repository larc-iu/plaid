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
  config: { igt: { dictionary: true, fields: { gloss: { inline: true } } } },
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
