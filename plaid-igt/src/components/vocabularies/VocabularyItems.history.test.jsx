import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The Entries tab at a past state (audit-vocab-history, ruled b): the entries
// as they were, nothing editable, and for a maintainer one entry at a time put
// back as it was, after a dry run that says what changes. Undo of an entry the
// restore brought back deletes it again.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  notifyPromise: vi.fn((p) => p),
  notifyWithAction: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: () => {},
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));
const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: false } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');
const feedback = await import('@/utils/feedback');

const FIELDS = [{ name: 'gloss', type: 'text' }];
const THEN = '2026-09-20T10:00:00Z';

// Now: kay (glossed "consume"). Then: kai (glossed "eat") and kai2, since
// deleted.
const NOW_ITEMS = [{ id: 'a', form: 'kay', metadata: { gloss: 'consume' } }];
const THEN_ITEMS = [
  { id: 'a', form: 'kai', metadata: { gloss: 'eat' } },
  { id: 'b', form: 'kai2', metadata: { gloss: 'food' } },
];

const makeClient = () => {
  const calls = [];
  const client = {
    calls,
    withOperation: (_label, fn) => fn(() => {}),
    query: vi.fn(async () => ({ results: [[0]] })),
    projects: { list: async () => [] },
    vocabLayers: {
      get: async (id, withItems) => ({
        id,
        name: 'Lexicon',
        config: {},
        timeModified: null,
        ...(withItems ? { items: structuredClone(NOW_ITEMS) } : {}),
      }),
      auditPage: async () => ({ entries: [{ id: 'op1', time: 't', endTime: 't' }] }),
      restoreItem: vi.fn(async (id, itemId, asOf, opts, message) => {
        calls.push(['restoreItem', itemId, asOf, !!opts?.dryRun, message ?? null]);
        if (itemId === 'b') return { inserted: true, form: false, metadata: false, total: 1 };
        return { inserted: false, form: true, metadata: true, total: 2 };
      }),
    },
    vocabItems: {
      delete: vi.fn(async (id, message) => {
        calls.push(['delete', id, message]);
      }),
      bulkUpdate: vi.fn(async () => ({})),
    },
  };
  return client;
};

const mount = async (client, at, props = {}) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
        canManage
        past={{ time: THEN, vocabulary: { id: 'v1', items: structuredClone(THEN_ITEMS) } }}
        canRestore
        {...props}
      />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};

const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
const settle = async (view) => {
  for (let i = 0; i < 4; i++) await view.step(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
});

// The screen as VocabularyDetail drives it: `onRestored` goes back to now.
const { useState } = await import('react');
const Driven = ({ client }) => {
  const [past, setPast] = useState({
    time: THEN,
    vocabulary: { id: 'v1', items: structuredClone(THEN_ITEMS) },
  });
  return (
    <VocabularyItems
      vocabularyId="v1"
      vocabulary={{ id: 'v1' }}
      client={client}
      fields={FIELDS}
      writes={new WriteQueue()}
      canManage
      past={past}
      canRestore
      // Back to now, then the rail read again, as useVocabHistory does: the
      // view is on the live list before that list has been read again.
      onRestored={async () => {
        setPast(null);
        await new Promise((r) => setTimeout(r, 0));
      }}
    />
  );
};

describe('the Entries tab at a past state', () => {
  it('lists the entries as they were, deleted ones included, with nothing to edit', async () => {
    const view = await mount(makeClient(), '/vocabularies/v1?item=a');
    const text = document.body.textContent;
    expect(text).toContain('kai2');
    expect(document.querySelector('input[id$="-form"]').value).toBe('kai');
    expect(document.querySelector('input[id$="-form"]').disabled).toBe(true);
    expect(button('Save')).toBeUndefined();
    expect(button('New')).toBeUndefined();
    await view.unmount();
  });

  it('offers no restore to someone who does not maintain the vocabulary', async () => {
    const view = await mount(makeClient(), '/vocabularies/v1?item=a', { canRestore: false });
    expect(button('Restore')).toBeUndefined();
    await view.unmount();
  });

  it('shows what a restore changes, and restores under a message naming the entry', async () => {
    const client = makeClient();
    const onRestored = vi.fn(async () => {});
    const view = await mount(client, '/vocabularies/v1?item=a', { onRestored });
    await view.step(() => button('Restore').click());
    await settle(view);
    expect(client.calls[0]).toEqual(['restoreItem', 'a', THEN, true, null]);
    const text = document.body.textContent;
    expect(text).toContain('Form: “kay” → “kai”');
    expect(text).toContain('Gloss: “consume” → “eat”');

    const confirm = all(document.body, '[role="dialog"] button').find(
      (b) => b.textContent.trim() === 'Restore',
    );
    await view.step(() => confirm.click());
    await settle(view);
    const [, id, asOf, dry, message] = client.calls.find((c) => c[0] === 'restoreItem' && !c[3]);
    expect([id, asOf, dry]).toEqual(['a', THEN, false]);
    expect(message).toBe(`Restore entry “kai” to ${new Date(THEN).toLocaleString()}`);
    expect(onRestored).toHaveBeenCalled();
    await view.unmount();
  });

  it('brings a deleted entry back, and its Undo deletes it again', async () => {
    const client = makeClient();
    const view = await mount(client, '/vocabularies/v1?item=b');
    expect(document.body.textContent).toContain('Deleted since');
    await view.step(() => button('Restore').click());
    await settle(view);
    expect(document.body.textContent).toContain('The entry comes back as it was.');
    expect(document.body.textContent).toContain('Its links in documents do not come back.');
    const confirm = all(document.body, '[role="dialog"] button').find(
      (b) => b.textContent.trim() === 'Restore',
    );
    await view.step(() => confirm.click());
    await settle(view);
    expect(feedback.notifyWithAction).toHaveBeenCalledTimes(1);
    const [, , action] = feedback.notifyWithAction.mock.calls[0];
    expect(action.label).toBe('Undo');
    await view.step(() => action.onClick());
    await settle(view);
    expect(client.vocabItems.delete).toHaveBeenCalledWith('b', 'Delete entry “kai2”');
    await view.unmount();
  });

  it('fills the form from the entry as the restore left it, not as it read before', async () => {
    const client = makeClient();
    let restored = false;
    // The read after the restore lands only when the test says, so the screen
    // has shown the live list as it was before it.
    let land;
    const landed = new Promise((r) => {
      land = r;
    });
    const get = client.vocabLayers.get;
    client.vocabLayers.get = async (id, withItems) => {
      const v = await get(id, withItems);
      if (withItems && restored) {
        await landed;
        v.items = [{ id: 'a', form: 'kai', metadata: { gloss: 'eat' } }];
      }
      return v;
    };
    const restoreItem = client.vocabLayers.restoreItem;
    client.vocabLayers.restoreItem = async (...args) => {
      if (!args[3]?.dryRun) restored = true;
      return restoreItem(...args);
    };
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=a']}>
        <Driven client={client} />
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => button('Restore').click());
    await settle(view);
    const confirm = all(document.body, '[role="dialog"] button').find(
      (b) => b.textContent.trim() === 'Restore',
    );
    await view.step(() => confirm.click());
    await settle(view);
    await view.step(async () => land());
    await settle(view);
    const form = document.querySelector('input[id$="-form"]');
    expect(form.disabled).toBe(false);
    expect(form.value).toBe('kai');
    expect(document.querySelector('input[id$="-field-0"]').value).toBe('eat');
    await view.unmount();
  });
});

describe("an entry's History", () => {
  it('opens the rail on the entry, and follows the entry opened next', async () => {
    const client = makeClient();
    const opened = [];
    const view = await mount(client, '/vocabularies/v1?item=a', {
      past: null,
      onOpenHistory: (id) => opened.push(id),
    });
    await view.step(() => button('History').click());
    expect(opened).toEqual(['a']);
    await view.unmount();

    const followed = [];
    const again = await mount(client, '/vocabularies/v1?item=a', {
      past: null,
      historyItemId: 'b',
      onOpenHistory: (id) => followed.push(id),
    });
    expect(followed).toEqual(['a']);
    await again.unmount();
  });
});
