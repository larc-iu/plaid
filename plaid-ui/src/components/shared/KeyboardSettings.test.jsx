import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthContext } from '../../contexts/useAuth.js';
import { configureUi } from '../../lib/uiConfig.js';
import { createKeymap } from '../../lib/keymap.js';
import { renderComponent } from '../../test/renderComponent.jsx';
import { KeyboardSettings } from './KeyboardSettings.jsx';

configureUi({ appPrefix: 'test', appName: 'Test', configNamespace: 'igt' });

const GROUPS = [{ id: 'grid', label: 'Grid' }];
const actions = () => [
  { id: 'accept', scope: 'grid', group: 'grid', label: 'Accept the word', keys: ['Mod+Enter'] },
  {
    id: 'discard',
    scope: 'grid',
    group: 'grid',
    label: 'Discard the word',
    keys: ['Mod+Backspace'],
  },
  { id: 'fixed:Enter', scope: 'grid', group: null, label: 'Enter', keys: ['Enter'], fixed: true },
];

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const mount = async () => {
  const keymap = createKeymap(actions());
  const userData = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
  const auth = { user: { id: 'u@x' }, client: { userData } };
  view = await renderComponent(
    <AuthContext.Provider value={auth}>
      <KeyboardSettings keymap={keymap} groups={GROUPS} />
    </AuthContext.Provider>,
  );
  const button = (name) =>
    [...view.container.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent).trim() === name,
    );
  const press = (init) =>
    view.step(() =>
      view.container
        .querySelector('button[aria-label^="Press the new shortcut"]')
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })),
    );
  const change = (label) => view.step(() => button(`Change the shortcut for ${label}`).click());
  return { keymap, userData, button, press, change };
};

describe('KeyboardSettings', () => {
  it('binds the next chord pressed, live and on the account', async () => {
    const { keymap, userData, press, change } = await mount();
    await change('Accept the word');
    // A modifier on its way down is not a chord yet.
    await press({ key: 'Alt', altKey: true });
    await press({ key: 'a', code: 'KeyA', altKey: true });
    expect(keymap.chords('accept')).toEqual(['Alt+a']);
    expect(userData.put).toHaveBeenCalledWith('u@x', 'igt:keymap', {
      metadata: { accept: ['Alt+a'] },
    });
    expect(view.container.textContent).toContain('Reset all');
  });

  it('refuses a chord something else hears, and says what', async () => {
    const { keymap, userData, press, change } = await mount();
    await change('Accept the word');
    await press({ key: 'Backspace', ctrlKey: true });
    expect(view.container.querySelector('[role="status"]').textContent).toBe(
      'Ctrl+Backspace is “Discard the word”.',
    );
    await press({ key: 'Enter' });
    expect(view.container.querySelector('[role="status"]').textContent).toBe(
      'Enter has a fixed meaning here.',
    );
    await press({ key: 'c', ctrlKey: true });
    expect(view.container.querySelector('[role="status"]').textContent).toBe(
      'The browser uses Ctrl+C.',
    );
    await press({ key: 'k' });
    expect(view.container.querySelector('[role="status"]').textContent).toBe(
      'K types a character. Add Ctrl or Alt.',
    );
    expect(keymap.overrides()).toEqual({});
    expect(userData.put).not.toHaveBeenCalled();
    // Still listening: Escape is how it ends.
    await press({ key: 'Escape' });
    expect(view.container.querySelector('[role="status"]')).toBeNull();
  });

  it('resets one shortcut, and stores nothing once none is changed', async () => {
    const { keymap, userData, button, press, change } = await mount();
    await change('Discard the word');
    await press({ key: 'F8' });
    expect(keymap.chords('discard')).toEqual(['F8']);
    await view.step(() => button('Reset the shortcut for Discard the word').click());
    expect(keymap.chords('discard')).toEqual(['Mod+Backspace']);
    expect(userData.delete).toHaveBeenCalledWith('u@x', 'igt:keymap');
  });

  it('puts a binding back when the save fails', async () => {
    const { keymap, userData, press, change } = await mount();
    userData.put.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    await change('Accept the word');
    await press({ key: 'F9' });
    expect(keymap.chords('accept')).toEqual(['Mod+Enter']);
  });
});
