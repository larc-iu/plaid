import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { settle } from '@/domain/test-helpers.js';

// A field's role (gloss, definition, part of speech, status) is set in the
// vocabulary's field settings and stored on the field, and a field added by
// hand is given the role its name proposes, once.

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
// The tagsets editor stands in as its last props, so a test can save through
// it and read what it is shown.
const tagsetsManager = vi.hoisted(() => ({ props: null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: (props) => {
    tagsetsManager.props = props;
    return null;
  },
}));
// Radix's Select does not open under jsdom: drawn as a native select with the
// same value and onValueChange.
vi.mock('@ui/components/ui/select', () => {
  const Select = ({ value, onValueChange, children }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  );
  return {
    Select,
    SelectContent: ({ children }) => children,
    SelectItem: ({ value, children }) => <option value={value}>{children}</option>,
    SelectTrigger: ({ id }) => <span data-trigger={id} />,
    SelectValue: () => null,
  };
});
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

const serverOf = (fields) => {
  const server = { id: 'A', name: 'Lexicon', maintainers: ['u'], config: { igt: { fields } } };
  const client = {
    withOperation: (_label, fn) => fn(),
    vocabLayers: {
      get: async () => structuredClone(server),
      setConfig: async (_id, _ns, key, value) => {
        server.config.igt[key] = structuredClone(value);
      },
      update: async () => {},
    },
    projects: { list: async () => [] },
  };
  return { server, client };
};

const mount = async (client) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/A?tab=settings']}>
      <Routes>
        <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};
// The Role select on a field's row: the select after its trigger stand-in.
const roleSelect = (name) =>
  document.querySelector(`[data-trigger="role-${name}"]`)?.closest('select');
const optionText = (select) => select.options[select.selectedIndex].textContent;

describe('the vocabulary field settings, Role', () => {
  it("shows each field's stored role, None for a field without one whatever its name", async () => {
    const { client } = serverOf({
      gloss: { inline: true, role: 'gloss' },
      Meaning: { role: 'gloss' },
      status: {},
    });
    const view = await mount(client);
    expect(optionText(roleSelect('gloss'))).toBe('Gloss');
    expect(optionText(roleSelect('Meaning'))).toBe('Gloss');
    expect(optionText(roleSelect('status'))).toBe('None');
    expect([...roleSelect('status').options].map((o) => o.textContent)).toEqual([
      'None',
      'Gloss',
      'Definition',
      'Part of speech',
      'Status',
    ]);
    expect(roleSelect('morphType')).toBeFalsy();
    await view.unmount();
  });

  it('writes the role chosen, and clears it on None', async () => {
    const { server, client } = serverOf({ gloss: { inline: true }, Stage: {} });
    const view = await mount(client);
    await view.step(async () => {
      const select = roleSelect('Stage');
      select.value = 'status';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(5);
    });
    expect(server.config.igt.fields.Stage).toEqual({ inline: false, role: 'status' });
    await view.step(async () => {
      const select = roleSelect('Stage');
      select.value = select.options[0].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(5);
    });
    expect(server.config.igt.fields.Stage).toEqual({ inline: false });
    await view.unmount();
  });

  it('gives a field added by hand the role its name proposes', async () => {
    const { server, client } = serverOf({ gloss: { inline: true, role: 'gloss' } });
    const view = await mount(client);
    const input = document.querySelector('input[placeholder="New field name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (const name of ['Gloss (fr)', 'Etymology']) {
      await view.step(() => {
        setter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await view.step(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle(5);
      });
    }
    expect(server.config.igt.fields['Gloss (fr)']).toEqual({ inline: false, role: 'gloss' });
    expect(server.config.igt.fields.Etymology).toEqual({ inline: false });
    await view.unmount();
  });
});
