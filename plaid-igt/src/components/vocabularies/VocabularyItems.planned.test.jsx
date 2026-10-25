import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Replace and Bulk Add plan their writes from the entries as the server holds
// them in the write's turn, once (A3-1). When the answer to a write that
// landed was lost, the resend sends what was planned, under the same keys,
// so the run reports what it did. Planned again, it would see its own writes
// and say "Nothing replaced", or send the person back to the review.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
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

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: true } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');
const feedback = await import('@/utils/feedback');

const FIELDS = [{ name: 'gloss', type: 'text' }];

// The answer to a write that landed, lost on the way back.
const lost = (method) =>
  Object.assign(new Error('Network error: fetch failed at http://x/api/v1/vocab-items/bulk'), {
    status: 0,
    method,
  });

// A server holding `initial`. The first bulk write (of `loseKind`, when
// named) lands and its answer is lost. A request sent again under a key that
// landed is answered from what it stored, and writes nothing again. With
// `between`, the first write never reaches the server, and `between(items)`
// is another maintainer's edit made before the resend.
const stub = (initial, { loseKind = null, between = null } = {}) => {
  const items = structuredClone(initial);
  const sent = [];
  const landedKeys = new Set();
  let lose = 1;
  let n = 0;
  const keyed = (kind, apply) => async (body) => {
    const key = `${kind}.${n++}`;
    sent.push({ kind, body: structuredClone(body), key });
    const losing = (!loseKind || kind === loseKind) && lose-- > 0;
    if (losing && between) {
      between(items);
    } else if (!landedKeys.has(JSON.stringify(body))) {
      landedKeys.add(JSON.stringify(body));
      apply(body);
    }
    if (losing) throw lost(kind === 'bulkCreate' ? 'POST' : 'PATCH');
    return {};
  };
  const client = {
    ops: [],
    keySeed: () => ({ seed: 's' }),
    withOperation: async (label, fn, opts) => {
      client.ops.push({ label, opts });
      return fn(() => {});
    },
    batched(fn) {
      return fn(this);
    },
    query: async () => ({ results: [] }),
    vocabLayers: {
      get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(items) }),
    },
    projects: { list: async () => [] },
    vocabItems: {
      bulkUpdate: keyed('bulkUpdate', (updates) => {
        for (const u of updates) {
          const it = items.find((i) => i.id === u.id);
          if (!it) continue;
          if ('form' in u) it.form = u.form;
          for (const op of u.metadata ?? []) {
            if (op.op === 'set') it.metadata = { ...it.metadata, [op.path[0]]: op.value };
          }
        }
      }),
      bulkCreate: keyed('bulkCreate', (specs) => {
        for (const s of specs) items.push({ id: s.id, form: s.form, metadata: s.metadata ?? {} });
      }),
    },
  };
  return { client, sent, items };
};

const mount = async (client) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/v1']}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1', name: 'Lexicon' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue({ retryDelay: () => 0 })}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const button = (name) =>
  all(document.body, 'button').find((b) => b.textContent.trim().startsWith(name));
const drain = async (view) =>
  view.step(async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  });

let mounted = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

describe('a planned run whose answer was lost', () => {
  it('Replace reports the values it replaced', async () => {
    const { client, sent } = stub([
      { id: 'a', form: 'kat', metadata: {} },
      { id: 'b', form: 'dog', metadata: {} },
    ]);
    const view = await mount(client);
    mounted = view;
    await view.step(() => button('Replace').click());
    await view.step(() => setValue(document.getElementById('vocab-replace-find'), 'k'));
    await view.step(() => setValue(document.getElementById('vocab-replace-with'), 'c'));
    await view.step(() => button('Replace 1').click());
    await drain(view);

    const updates = sent.filter((s) => s.kind === 'bulkUpdate');
    expect(updates).toHaveLength(2);
    expect(updates[1].body).toEqual(updates[0].body);
    expect(feedback.notifyWarning).not.toHaveBeenCalled();
    expect(feedback.notifySuccess).toHaveBeenCalledWith('1 value replaced in Form.', 'Replaced');
  });

  it('Bulk Add reports the entries it added, under the ids it minted once', async () => {
    const { client, sent, items } = stub([{ id: 'a', form: 'kat', metadata: {} }]);
    const view = await mount(client);
    mounted = view;
    await view.step(() => button('Bulk Add').click());
    await view.step(() =>
      setValue(document.querySelector('textarea'), 'form\tgloss\nperro\tdog\nchat\tcat'),
    );
    await view.step(() => button('Next: columns').click());
    await view.step(() => button('Next: review').click());
    await view.step(() => button('Add 2').click());
    await drain(view);

    const creates = sent.filter((s) => s.kind === 'bulkCreate');
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toEqual(creates[0].body);
    expect(items.map((i) => i.form)).toEqual(['kat', 'perro', 'chat']);
    expect(feedback.notifySuccess).toHaveBeenCalledWith('Added 2 entries', 'Bulk Add complete');
    expect(document.body.textContent).not.toContain('changed since');
  });
});

// The first send never reached the server, and another maintainer changed the
// entries before it went again. The resend reads them again first, so it
// writes over nothing of theirs.
describe('a planned run whose first send never arrived', () => {
  it('Replace skips a value changed since the preview', async () => {
    const { client, sent, items } = stub(
      [
        { id: 'a', form: 'kat', metadata: {} },
        { id: 'b', form: 'dog', metadata: {} },
      ],
      {
        between: (now) => {
          now[0].form = 'kot';
        },
      },
    );
    const view = await mount(client);
    mounted = view;
    await view.step(() => button('Replace').click());
    await view.step(() => setValue(document.getElementById('vocab-replace-find'), 'k'));
    await view.step(() => setValue(document.getElementById('vocab-replace-with'), 'c'));
    await view.step(() => button('Replace 1').click());
    await drain(view);

    expect(sent.filter((s) => s.kind === 'bulkUpdate')).toHaveLength(1);
    expect(items.map((i) => i.form)).toEqual(['kot', 'dog']);
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
    expect(feedback.notifyWarning).toHaveBeenCalledWith(
      'Skipped 1 value changed since the preview.',
      'Nothing replaced',
    );
  });

  it('Bulk Add goes back to the review when someone added one of its headwords', async () => {
    const { client, sent, items } = stub([{ id: 'a', form: 'kat', metadata: {} }], {
      between: (now) => {
        now.push({ id: 'z', form: 'perro', metadata: {} });
      },
    });
    const view = await mount(client);
    mounted = view;
    await view.step(() => button('Bulk Add').click());
    await view.step(() =>
      setValue(document.querySelector('textarea'), 'form\tgloss\nperro\tdog\nchat\tcat'),
    );
    await view.step(() => button('Next: columns').click());
    await view.step(() => button('Next: review').click());
    await view.step(() => button('Add 2').click());
    await drain(view);

    expect(sent.filter((s) => s.kind === 'bulkCreate')).toHaveLength(1);
    expect(items.map((i) => i.form)).toEqual(['kat', 'perro']);
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('changed since');
  });
});

describe('a planned run that fills in entries, whose answer was lost', () => {
  it('Bulk Add reports what it filled in, not a change since the review', async () => {
    const { client, sent, items } = stub([{ id: 'a', form: 'kat', metadata: {} }], {
      loseKind: 'bulkUpdate',
    });
    const view = await mount(client);
    mounted = view;
    await view.step(() => button('Bulk Add').click());
    await view.step(() =>
      setValue(document.querySelector('textarea'), 'form\tgloss\nkat\tcat\nperro\tdog'),
    );
    await view.step(() => button('Next: columns').click());
    await view.step(() => button('Next: review').click());
    await view.step(() => button('Add 1').click());
    await drain(view);

    const updates = sent.filter((s) => s.kind === 'bulkUpdate');
    expect(updates).toHaveLength(2);
    expect(updates[1].body).toEqual(updates[0].body);
    expect(items.map((i) => [i.form, i.metadata.gloss])).toEqual([
      ['kat', 'cat'],
      ['perro', 'dog'],
    ]);
    expect(document.body.textContent).not.toContain('changed since');
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      'Added 1 entry, filled in 1',
      'Bulk Add complete',
    );
  });
});
