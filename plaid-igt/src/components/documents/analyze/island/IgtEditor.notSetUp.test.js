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
