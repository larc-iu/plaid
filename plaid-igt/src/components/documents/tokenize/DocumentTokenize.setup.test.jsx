import { expect, it } from 'vitest';
import { all } from '@ui/test/renderComponent.jsx';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { DocumentTokenize } from './DocumentTokenize.jsx';

// A project not set up for words is a plain fact, said as information: a red
// or warm banner means something is broken.
it('says a project not set up for words as plain information', async () => {
  const doc = fakeDocument({
    body: 'uno dos',
    sentences: [],
    layerInfo: { primaryTokenLayer: null },
  });
  const m = await mountDocumentHook(() => null, { doc, render: () => <DocumentTokenize /> });
  const line = all(m.container, '[data-tone]').find((n) =>
    n.textContent.includes('This project is not set up for words.'),
  );
  expect(line.getAttribute('data-tone')).toBe('info');
  await m.unmount();
});
