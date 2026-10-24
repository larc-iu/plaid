import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';
import { notifyError } from '@/utils/feedback';

// Copy as IGT, when the clipboard says no. Both routes can be refused (a
// denied permission, an insecure context where execCommand is off too), and
// the ✓ that follows a copy must not appear when nothing was copied.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
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
  doc = makeIgtDoc({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    client,
    user: null,
  });
  ({ host, editor } = mountIsland(doc));
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
    expect(notifyError).toHaveBeenCalledWith('Clipboard access was refused.', 'Failed to copy');
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

describe('copy as gb4e', () => {
  it('takes the free translation from the translation field, not the first filled one', async () => {
    resetIds();
    const raw = buildRawDoc({ sentFields: ['Note', 'Translation'] });
    const sentenceLayer = raw.textLayers[0].tokenLayers[0];
    sentenceLayer.spanLayers[0].spans = [{ id: 'sp-n', tokens: ['s-1'], value: 'said twice' }];
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
      client,
      user: null,
    });
    ({ host, editor } = mountIsland(doc));
    const writeText = acceptClipboard();

    await editor._copySentence(doc.sentences[0], editor._lastCtx, 'gb4e');
    expect(writeText.mock.calls[0][0]).toContain("\\glt `'");

    sentenceLayer.spanLayers[1].spans = [{ id: 'sp-t', tokens: ['s-1'], value: 'the cat' }];
    doc = makeIgtDoc({
      raw,
      project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
      client,
      user: null,
    });
    editor.destroy();
    host.remove();
    ({ host, editor } = mountIsland(doc));
    await editor._copySentence(doc.sentences[0], editor._lastCtx, 'gb4e');
    expect(writeText.mock.calls[1][0]).toContain("\\glt `the cat'");
  });
});
