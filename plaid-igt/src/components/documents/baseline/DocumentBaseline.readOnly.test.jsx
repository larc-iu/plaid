import { expect, it } from 'vitest';
import { all } from '@ui/test/renderComponent.jsx';
import { fakeDocument, mountDocumentHook } from '../../../test/mountDocumentHook.jsx';
import { DocumentBaseline } from './DocumentBaseline.jsx';

// A page that turns read-only while the Baseline editor is open (access lost,
// the document deleted) keeps the draft on screen, but the box takes no more
// typing and Save is off: a save would only be refused again.
it('a page turned read-only keeps the draft, with the box read-only and Save off', async () => {
  const doc = fakeDocument({ body: 'uno dos' });
  const m = await mountDocumentHook(() => null, { doc, render: () => <DocumentBaseline /> });
  const button = (label) => all(m.container, 'button').find((b) => b.textContent.includes(label));
  await m.step(async () => button('Edit text').click());
  const box = () => m.container.querySelector('#baseline-text');
  expect(box().readOnly).toBe(false);
  expect(button('Save changes').disabled).toBe(false);

  await m.setInputs({ ctx: { readOnly: true, canWrite: false } });
  expect(box().value).toBe('uno dos');
  expect(box().readOnly).toBe(true);
  expect(button('Save changes').disabled).toBe(true);
  await m.unmount();
});
