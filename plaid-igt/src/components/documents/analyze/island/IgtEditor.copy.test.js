import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyError } from '@/utils/feedback';

// Copy as IGT, when the clipboard says no. Both routes can be refused (a
// denied permission, an insecure context where execCommand is off too), and
// the ✓ that follows a copy must not appear when nothing was copied.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;
let doc;

const FIELDS = { morphFields: [], wordFields: [], sentFields: [] };

const mount = () => {
  resetIds();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
};

const refuseClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
  });
  document.execCommand = vi.fn(() => false);
};

const acceptClipboard = () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
};

beforeEach(() => {
  host = null;
  editor = null;
  vi.clearAllMocks();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
});

describe('copying a sentence', () => {
  it('says nothing was copied rather than flashing the tick', async () => {
    mount();
    refuseClipboard();
    const sentence = doc.sentences[0];

    await editor._copySentence(sentence, FIELDS, 'plain');

    expect(editor._copiedFlash).toBeNull();
    expect(notifyError).toHaveBeenCalledWith('Clipboard access was refused.', 'Could not copy');
  });

  it('keeps the tick for a copy that landed', async () => {
    mount();
    const writeText = acceptClipboard();
    const sentence = doc.sentences[0];

    await editor._copySentence(sentence, FIELDS, 'plain');

    expect(writeText).toHaveBeenCalled();
    expect(editor._copiedFlash).toBe(sentence.id);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does not flash the link tick when the link was not copied', async () => {
    mount();
    refuseClipboard();

    await editor._copySentenceLink(doc.sentences[0]);

    expect(editor._linkFlash).toBeFalsy();
    expect(notifyError).toHaveBeenCalled();
  });
});
