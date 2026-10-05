import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

// L3-UD-LIVE polish: the Text Editor's token panel and help line.
// - A read-only Text Editor said "Click a token to toggle its sentence
//   boundary. Hover a token to edit its words or delete it. Select text to
//   create a token." None of that works there.
// - "Add word" appended an input without focusing it, so the next keys went
//   nowhere, and Save then dropped the empty word without a word: "Dogs"
//   became the one word "Dog".

const feedback = vi.hoisted(() => ({ notifyError: vi.fn(), notifyInfo: vi.fn() }));
vi.mock('../../utils/feedback.jsx', () => feedback);

const { TokenVisualizer } = await import('./TokenVisualizer.jsx');

const TEXT = 'Dogs bark';
const words = [
  { id: 'w1', begin: 0, end: 4 },
  { id: 'w2', begin: 5, end: 9 },
];
const sentences = [{ id: 's1', begin: 0, end: 9 }];

const editing = () => ({
  onWordCreate: vi.fn(),
  onWordDelete: vi.fn(),
  onSentenceToggle: vi.fn(),
  onSetWordMorphemes: vi.fn(),
  onOpenInAnnotate: vi.fn(),
});
const readOnly = () => ({ onOpenInAnnotate: vi.fn() });

const mount = (props) =>
  renderComponent(
    <TokenVisualizer
      text={TEXT}
      originalText={TEXT}
      sentenceTokens={sentences}
      wordTokens={words}
      {...props}
    />,
  );

const hint = (view) => view.container.querySelector('p')?.textContent ?? '';
const badge = (view, id) => view.container.querySelector(`[data-word-id="${id}"]`);

// Hover a badge and wait out the panel's open delay.
async function openPanel(view, id) {
  await view.step(async () => {
    badge(view, id).dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }),
    );
    await new Promise((r) => setTimeout(r, 250));
  });
  return document.body.querySelector('[data-token-panel="true"]');
}

beforeEach(() => {
  feedback.notifyInfo.mockClear();
});

describe('the token panel and help line', () => {
  it('offers only the hand-off to Annotate when the document is read-only', async () => {
    const view = await mount(readOnly());
    expect(hint(view)).toBe('Alt+click a token to annotate its sentence.');
    expect(badge(view, 'w1').getAttribute('title')).toBe('Alt+click to annotate this sentence.');
    await view.unmount();

    const none = await mount({});
    expect(none.container.querySelector('p')).toBeNull();
    expect(badge(none, 'w1').hasAttribute('title')).toBe(false);
    await none.unmount();
  });

  it('names every action when the document can be edited', async () => {
    const view = await mount(editing());
    expect(hint(view)).toBe(
      'Click a token to toggle its sentence boundary. Hover a token to edit its words or delete it. ' +
        'Select text to create a token. Alt+click a token to annotate its sentence.',
    );
    expect(badge(view, 'w1').getAttribute('title')).toBe(
      'Click to toggle the sentence boundary. Alt+click to annotate this sentence.',
    );
    await view.unmount();
  });

  it('focuses the word Add word adds, and not a word on hover', async () => {
    const view = await mount(editing());
    const panel = await openPanel(view, 'w1');
    expect(panel).not.toBeNull();
    const inputs = () => all(document.body, '[data-token-panel="true"] input');
    expect(inputs()).toHaveLength(1);
    expect(panel.contains(document.activeElement)).toBe(false);
    await view.step(() => byText(document.body, 'button', 'Add word').click());
    expect(inputs()).toHaveLength(2);
    expect(document.activeElement).toBe(inputs()[1]);
    expect(inputs()[1].getAttribute('aria-label')).toBe('Word 2');
    await view.unmount();
  });

  it('says an empty word was left out', async () => {
    const props = editing();
    const view = await mount(props);
    await openPanel(view, 'w1');
    await view.step(() => byText(document.body, 'button', 'Add word').click());
    await view.step(() => byText(document.body, 'button', 'Save').click());
    expect(feedback.notifyInfo).toHaveBeenCalledWith('Empty word left out.');
    await view.unmount();
  });
});
