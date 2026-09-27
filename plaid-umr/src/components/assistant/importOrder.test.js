import { describe, it, expect } from 'vitest';

// The card and the adapter must not import each other. With a cycle, whichever
// of the two a page evaluated first decided whether the adapter's
// `ExampleCard` existed: loaded card first (a hot update to either one does
// that), the browser threw "Cannot access 'ExampleCard' before initialization"
// and the page went blank. The card is imported FIRST here, on purpose.
describe('the assistant adapter and its card', () => {
  it('load in either order', async () => {
    const card = await import('./ExampleCard.jsx');
    const { UMR_ASSISTANT } = await import('./adapter.js');
    expect(card.ExampleCard).toBeTypeOf('function');
    expect(UMR_ASSISTANT.ExampleCard).toBe(card.ExampleCard);
  });
});
