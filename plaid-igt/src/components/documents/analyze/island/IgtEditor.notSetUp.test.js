import { it, expect, afterEach } from 'vitest';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';

// A project not fully set up is a plain fact, said in the muted empty state:
// a warm line means something is broken.

let host;
let editor;
afterEach(() => {
  editor?.destroy();
  host?.remove();
});

it('says a project not fully set up in the plain empty state', () => {
  resetIds();
  const doc = makeIgtDoc({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    client: makeFakeClient(),
    user: null,
  });
  const info = doc.layerInfo;
  Object.defineProperty(doc, 'layerInfo', {
    configurable: true,
    get: () => ({ ...info, primaryTokenLayer: null }),
  });
  ({ host, editor } = mountIsland(doc));
  const empty = host.querySelector('.igt-island__empty');
  expect(empty.textContent).toContain(NOT_SET_UP);
  expect(empty.className).toBe('igt-island__empty');
});

// H16-6: a document with no text sent the reader to Tokenize, which sent
// them back to Baseline.
it('sends a document with no text to the Baseline tab, and one with text to Tokenize', () => {
  for (const [body, line, label, tab] of [
    ['', 'No text. Add it on the Baseline tab.', 'Go to Baseline', 'baseline'],
    // REV-HFT-5: whitespace only is no text either.
    ['\n  \u0085', 'No text. Add it on the Baseline tab.', 'Go to Baseline', 'baseline'],
    ['ab cd', 'No sentences. Split the text on the Tokenize tab.', 'Go to Tokenize', 'tokenize'],
  ]) {
    resetIds();
    const doc = makeIgtDoc({
      raw: buildRawDoc({ body, words: [], morphemes: [], sentences: [] }),
      client: makeFakeClient(),
    });
    const went = [];
    ({ host, editor } = mountIsland(doc, { onNavigateTab: (t) => went.push(t) }));
    const empty = host.querySelector('.igt-island__empty');
    expect(empty.textContent).toContain(line);
    const button = empty.querySelector('button');
    expect(button.textContent.trim()).toBe(label);
    button.click();
    expect(went).toEqual([tab]);
    editor.destroy();
    host.remove();
    editor = null;
  }
});
