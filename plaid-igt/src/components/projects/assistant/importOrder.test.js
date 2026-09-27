import { describe, it, expect } from 'vitest';

// The card, the Markdown writer and the adapter must not import each other in
// a ring. With a cycle, whichever a page evaluated first decided whether the
// adapter's members existed: loaded card first (a hot update to any of them
// does that), the browser threw "Cannot access 'ExampleCard' before
// initialization" and the page went blank. The card and the writer are
// imported FIRST here, on purpose.
describe('the assistant adapter, its card and its Markdown writer', () => {
  it('load in either order', async () => {
    const card = await import('./ExampleCard.jsx');
    const md = await import('./citationMarkdown.js');
    const { IGT_ASSISTANT } = await import('./adapter.js');
    expect(card.ExampleCard).toBeTypeOf('function');
    expect(IGT_ASSISTANT.ExampleCard).toBe(card.ExampleCard);
    expect(IGT_ASSISTANT.citationToMarkdown).toBe(md.citationToMarkdown);
  });
});
