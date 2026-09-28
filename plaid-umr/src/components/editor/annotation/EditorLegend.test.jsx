import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';
import { EditorLegend } from './EditorLegend.jsx';
import { keys } from '../../../lib/keymap.js';

// The Annotate tab's key legend prints the keymap, so a rebound key is the
// key it shows, and the moves mirror in a right-to-left document as the node
// menu's do.
describe('EditorLegend', () => {
  afterEach(() => keys.setOverrides({}));
  const row = (root, title) =>
    [...root.querySelectorAll('.flex')].find(
      (r) => r.querySelector('strong')?.textContent === title,
    );
  const caps = (el) => texts(el, 'kbd');

  it('prints each key from the keymap, rebound ones included', async () => {
    const r = await renderComponent(<EditorLegend project={{ config: {} }} />);
    expect(caps(row(r.container, 'Document'))).toEqual(['C', 'T', 'O', 'D']);
    await r.step(() => keys.setOverrides({ 'node.docRelations': ['g'] }));
    expect(caps(row(r.container, 'Document'))).toEqual(['C', 'T', 'O', 'G']);
    await r.unmount();
  });

  it('mirrors the arrows of the two moves in a right-to-left document', async () => {
    const ltr = await renderComponent(<EditorLegend project={{ config: {} }} />);
    const moves = (root) => caps(row(root, 'Change')).filter((c) => c === '←' || c === '→');
    expect(moves(ltr.container)).toEqual(['←', '→']);
    await ltr.unmount();
    const rtl = await renderComponent(<EditorLegend project={{ config: {} }} direction="rtl" />);
    expect(moves(rtl.container)).toEqual(['→', '←']);
    await rtl.unmount();
  });

  it('names the contributed mark only in a project that reviews someone', async () => {
    const plain = await renderComponent(<EditorLegend project={{ config: {} }} />);
    expect(plain.container.querySelector('.plaid-prov--contributed')).toBeNull();
    await plain.unmount();
    const reviewing = { config: { plaid: { review: { users: ['b@x.com'] } } } };
    const r = await renderComponent(<EditorLegend project={reviewing} />);
    expect(r.container.querySelector('.plaid-prov--contributed')).not.toBeNull();
    await r.unmount();
  });
});
