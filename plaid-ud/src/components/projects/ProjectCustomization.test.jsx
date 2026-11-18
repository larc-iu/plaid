import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// One rule for Save in every app: the default button, disabled until its
// section differs from what is stored. This tab has one Save for all of it, and
// it used to be enabled with nothing changed.

const managed = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useManagedProject.js', () => ({ useManagedProject: () => managed.current }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => ({ getClient: () => null }) }));
const feedback = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('../../utils/feedback.jsx', () => feedback);

// The tab reads the project only through this resolver, so a hand-made answer
// stands in for a configured project.
const info = vi.hoisted(() => ({
  isConfigured: true,
  vocab: {
    upos: ['NOUN', 'VERB'],
    xpos: [],
    deprel: ['nsubj'],
    featureInventory: { list: [{ key: 'Number', values: ['Sing'] }] },
  },
  colors: { upos: {}, deprel: {} },
  modes: {},
  descriptions: { upos: {}, xpos: {}, deprel: {}, feats: {} },
}));
vi.mock('../../utils/udLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUdLayerInfo: () => info,
}));

const { ProjectCustomization } = await import('./ProjectCustomization.jsx');
const { autoColor } = await import('../../utils/udVocab.js');

// A typed value, as React hears it from the keyboard.
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
    input,
    value,
  );
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <ProjectCustomization />
    </MemoryRouter>,
  );

beforeEach(() => {
  managed.current = {
    project: { id: 'p1', name: 'P', config: {} },
    loading: false,
    fetchProject: vi.fn(),
    canConfigure: true,
  };
});

describe('UD customization', () => {
  it('keeps Save disabled until something on the tab changes, and again once undone', async () => {
    const view = await mount();
    const save = button(view.container, 'Save');
    expect(save.disabled).toBe(true);
    await view.step(() => button(view.container, 'Add feature').click());
    expect(save.disabled).toBe(false);
    await view.step(() => view.container.querySelector('[aria-label="Remove feature"]').click());
    expect(save.disabled).toBe(true);
    await view.unmount();
  });

  // Q2-UD-POLISH-5: a change at the top of the page was dropped without a word
  // by a tab click, with its Save a long page below.
  it('asks before leaving with a change made, and keeps Save at the bottom of the window', async () => {
    const view = await mount();
    expect(hasUnsavedDraft()).toBe(null);
    await view.step(() => button(view.container, 'Add feature').click());
    expect(hasUnsavedDraft()).toBe('The change to these settings');
    const bar = button(view.container, 'Save').parentElement;
    expect(bar.className.split(/\s+/)).toContain('sticky');
    expect(bar.textContent).toContain('Not saved');
    await view.unmount();
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('draws a feature row trash grey, red only on hover', async () => {
    const view = await mount();
    const trash = view.container.querySelector('[aria-label="Remove Number"]');
    const classes = trash.className.split(/\s+/);
    expect(classes).toContain('text-muted-foreground');
    expect(classes).toContain('hover:text-destructive');
    expect(classes).not.toContain('text-destructive');
    await view.unmount();
  });

  // H18-2: emptying a hex box filled it again with the automatic color, so a
  // hex typed next was appended to it, and a malformed one was saved.
  it('leaves an emptied hex box empty, showing the automatic color as its placeholder', async () => {
    const view = await mount();
    const hex = view.container.querySelector('[aria-label="VERB hex"]');
    expect(hex.value).toBe('');
    expect(hex.placeholder).toBe(autoColor('VERB'));
    await view.step(() => type(hex, '#00ff00'));
    expect(hex.value).toBe('#00ff00');
    await view.step(() => type(hex, ''));
    expect(hex.value).toBe('');
    await view.unmount();
  });

  it('refuses to save a hex that is not a color, and says which', async () => {
    feedback.notifyError.mockClear();
    const view = await mount();
    const hex = view.container.querySelector('[aria-label="NOUN hex"]');
    await view.step(() => type(hex, '#12'));
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    await view.step(() => button(view.container, 'Save').click());
    expect(feedback.notifyError).toHaveBeenCalledWith(
      'NOUN: "#12" is not a color of the form #RGB or #RRGGBB.',
      'UD settings not saved',
    );
    expect(managed.current.fetchProject).not.toHaveBeenCalled();
    await view.unmount();
  });

  // REV-HFU-4: a colour whose tag is no longer listed has no box to correct
  // it in, so it does not hold Save back.
  it('saves past a bad colour on a tag no longer listed', async () => {
    feedback.notifyError.mockClear();
    const view = await mount();
    await view.step(() => type(view.container.querySelector('[aria-label="NOUN hex"]'), '#12'));
    await view.step(() => view.container.querySelector('[aria-label="Remove NOUN"]').click());
    expect(view.container.querySelector('[aria-label="NOUN hex"]')).toBeNull();
    await view.step(async () => {
      button(view.container, 'Save').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const messages = feedback.notifyError.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('is not a color'))).toBe(false);
    await view.unmount();
  });

  // REV-HFU-8: a three-digit hex was stored before the check, so it still is,
  // as typed, and the swatch shows it.
  it('takes a three-digit hex as it was taken before', async () => {
    feedback.notifyError.mockClear();
    const view = await mount();
    const hex = view.container.querySelector('[aria-label="NOUN hex"]');
    await view.step(() => type(hex, '#F00'));
    expect(hex.getAttribute('aria-invalid')).toBe(null);
    expect(view.container.querySelector('[aria-label="NOUN color"]').value).toBe('#ff0000');
    await view.step(async () => {
      button(view.container, 'Save').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const messages = feedback.notifyError.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('is not a color'))).toBe(false);
    await view.unmount();
  });
});
