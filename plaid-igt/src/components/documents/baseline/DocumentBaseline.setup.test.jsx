import { expect, it } from 'vitest';
import { all } from '@ui/test/renderComponent.jsx';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { DocumentBaseline } from './DocumentBaseline.jsx';

// A project not fully set up is a plain fact, said as information: a red or
// warm banner means something is broken.
it('says a project not fully set up as plain information', async () => {
  const doc = fakeDocument({ body: 'uno dos', layerInfo: { primaryTextLayer: null } });
  const m = await mountDocumentHook(() => null, { doc, render: () => <DocumentBaseline /> });
  const line = all(m.container, '[data-tone]').find((n) => n.textContent.includes(NOT_SET_UP));
  expect(line.getAttribute('data-tone')).toBe('info');
  expect(m.container.querySelector('.text-destructive')).toBe(null);
  await m.unmount();
});
