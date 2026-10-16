import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const { RespellPanel } = await import('./RespellPanel.jsx');

// Ruling 22 (Luke, 2026-10-16): respelling lexicon entries changes shared
// dictionary entries, so it is off until asked for. Morpheme forms stay on.
describe('RespellPanel defaults', () => {
  it('leaves lexicon entries off and morpheme forms on', async () => {
    const { container, unmount } = await renderComponent(
      <RespellPanel project={{ id: 'p1', vocabs: [] }} projectId="p1" client={{}} layerInfo={{}} />,
    );
    const box = (text) =>
      all(container, 'label')
        .find((l) => l.textContent.includes(text))
        .querySelector('input[type="checkbox"]');
    expect(box('Also respell lexicon entries').checked).toBe(false);
    expect(box('Also respell morpheme forms').checked).toBe(true);
    await unmount();
  });
});
