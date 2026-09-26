import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The vocabulary's schema writes and its name take their turn in one queue,
// closing the tab asks while they are on their way, and the vocabulary's own
// tabs ask before an entry typed on the Entries tab is lost.

// The Entries tab stands in as a screen holding a typed entry.
vi.mock('./VocabularyItems', async () => {
  const { useUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');
  return {
    VocabularyItems: () => {
      useUnsavedDraft('The entry you have typed');
      return null;
    },
  };
});
vi.mock('./VocabularyMaintainers', () => ({ VocabularyMaintainers: () => null }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: () => null,
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));

const auth = vi.hoisted(() => ({
  client: null,
  user: { id: 'u', isAdmin: true },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// A server holding vocabulary A. `holds` is a list of deferreds the next
// writes wait on, in order.
const stub = () => {
  const calls = [];
  const holds = [];
  const write = (kind) => async () => {
    calls.push(kind);
    const hold = holds.shift();
    if (hold) await hold.promise;
  };
  return {
    calls,
    holds,
    client: {
      vocabLayers: {
        get: async () => ({ id: 'A', name: 'Ayvale lexicon', config: {}, maintainers: ['u'] }),
        setConfig: write('setConfig'),
        update: write('update'),
      },
      projects: { list: async () => [] },
    },
  };
};

const mount = async (client, at) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const asks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
const firstInlineSwitch = () => document.querySelector('button[role="switch"]');
const nameInput = () => document.querySelector('input[placeholder="Enter vocabulary name"]');

describe('the vocabulary screen', () => {
  it('asks before the tab closes while a schema write is on its way', async () => {
    const { client, holds } = stub();
    const held = deferred();
    holds.push(held);
    const view = await mount(client, '/vocabularies/A?tab=settings');
    expect(asks()).toBe(false);
    await view.step(() => firstInlineSwitch().click());
    expect(asks()).toBe(true);
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    expect(asks()).toBe(false);
    await view.unmount();
  });

  it('sends a rename after the schema write made before it, not beside it', async () => {
    const { client, calls, holds } = stub();
    const held = deferred();
    holds.push(held);
    const view = await mount(client, '/vocabularies/A?tab=settings');
    await view.step(() => firstInlineSwitch().click());
    await view.step(() => setValue(nameInput(), 'Beeworth lexicon'));
    await view.step(async () => {
      button('Save').click();
      await settle();
    });
    expect(calls).toEqual(['setConfig']);
    await view.step(async () => {
      held.resolve();
      await settle();
    });
    expect(calls).toEqual(['setConfig', 'update']);
    await view.unmount();
  });

  it('asks before its own tabs take an entry that is typed and not saved', async () => {
    const { client } = stub();
    confirm.mockClear();
    const view = await mount(client, '/vocabularies/A');
    const settings = all(document.body, '[role="tab"]').find((t) =>
      t.textContent.includes('Settings'),
    );
    await view.step(async () => {
      settings.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await settle();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // Refused: the Entries tab stays.
    expect(settings.getAttribute('data-state')).toBe('inactive');
    await view.unmount();
  });
});
