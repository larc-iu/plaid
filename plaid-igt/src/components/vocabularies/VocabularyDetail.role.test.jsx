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
vi.mock('./VocabularyBorrowers', () => ({ VocabularyBorrowers: () => null }));
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
const { notifyError } = await import('@/utils/feedback');

const serverOf = (fields) => {
  const server = { id: 'A', name: 'Lexicon', project: 'P', config: { igt: { fields } } };
  const client = {
    withOperation: (_label, fn) => fn(),
    vocabLayers: {
      get: async () => structuredClone(server),
      setConfig: async (_id, _ns, key, value) => {
        server.config.igt[key] = structuredClone(value);
      },
      update: async () => {},
    },
    projects: {
      list: async () => [],
      get: async (id) => ({ id, name: 'Pear', maintainers: ['u'] }),
    },
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
      select.value = 'pos';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(5);
    });
    expect(server.config.igt.fields.Stage).toEqual({ inline: false, role: 'pos' });
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

// Every vocabulary has a field holding the Status role (Luke, 2026-11-12): a
// job marks the entries it makes there, and the Entries screen filters on it.
describe('the field holding the Status role', () => {
  const rowOf = (name) => document.getElementById(`inline-${name}`)?.closest('tr');
  const removeOf = (name) => rowOf(name)?.querySelector('button[title="Remove"]');
  const selectOf = (what, name) =>
    document.querySelector(`[data-trigger="${what}-${name}"]`)?.closest('select');

  it('cannot be removed, and says it is required', async () => {
    const { server, client } = serverOf({
      gloss: { inline: true, role: 'gloss' },
      state: { tagset: 'Status', role: 'status' },
      note: {},
    });
    const view = await mount(client);
    expect(removeOf('state').disabled).toBe(true);
    expect(rowOf('state').textContent).toContain('Required');
    expect(removeOf('note').disabled).toBe(false);
    await view.step(async () => {
      removeOf('state').click();
      await settle(5);
    });
    expect(server.config.igt.fields.state).toEqual({ tagset: 'Status', role: 'status' });
    await view.unmount();
  });

  it('keeps its role: it reads Status, with nothing to change it to', async () => {
    const { client } = serverOf({ state: { tagset: 'Status', role: 'status' }, note: {} });
    const view = await mount(client);
    expect(roleSelect('state')).toBeFalsy();
    expect(rowOf('state').textContent).toContain('Status');
    await view.unmount();
  });

  // A type of Entry would clear every Status value and hold the field to no
  // list (REV-J-C-1). Where it is shown is fixed with it.
  it('keeps its type and where it is shown: each reads as it is stored, with nothing to change it to', async () => {
    const { server, client } = serverOf({
      state: { tagset: 'Status', role: 'status', scope: 'entry', lang: 'en' },
      note: {},
    });
    const view = await mount(client);
    expect(selectOf('type', 'state')).toBeFalsy();
    expect(selectOf('scope', 'state')).toBeFalsy();
    const cells = [...rowOf('state').querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[2]).toBe('Text');
    expect(cells[3]).toBe('Headword only');
    // Every other field keeps both.
    expect(selectOf('type', 'note')).toBeTruthy();
    expect(selectOf('scope', 'note')).toBeTruthy();
    expect(server.config.igt.fields.state).toEqual({
      tagset: 'Status',
      role: 'status',
      scope: 'entry',
      lang: 'en',
    });
    await view.unmount();
  });

  it('is the only one: no other field is offered the role while it holds it', async () => {
    const { client } = serverOf({ state: { tagset: 'Status', role: 'status' }, note: {} });
    const view = await mount(client);
    expect([...roleSelect('note').options].map((o) => o.textContent)).toEqual([
      'None',
      'Gloss',
      'Definition',
      'Part of speech',
    ]);
    await view.unmount();
  });

  it('is the only one: a field added by hand under the name Status is given no role', async () => {
    const { server, client } = serverOf({ state: { tagset: 'Status', role: 'status' } });
    const view = await mount(client);
    const input = document.querySelector('input[placeholder="New field name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await view.step(() => {
      setter.call(input, 'Status');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(5);
    });
    expect(server.config.igt.fields.Status).toEqual({ inline: false });
    expect(server.config.igt.fields.state.role).toBe('status');
    await view.unmount();
  });
});

describe('the vocabulary tagsets, the published Status value', () => {
  it('is never taken from the Status field by a tagset chosen in the Fields table (HUNT-recent 4)', async () => {
    const { server, client } = serverOf({ state: { tagset: 'Workflow', role: 'status' } });
    server.config.igt.tagsets = {
      Workflow: { delimiters: '', mode: 'closed', values: [{ value: 'published' }] },
      Other: { delimiters: '', mode: 'closed', values: [{ value: 'draft' }] },
    };
    const view = await mount(client);
    const select = document.querySelector('[data-trigger="tagset-state"]').closest('select');
    await view.step(async () => {
      select.value = 'Other';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await settle(5);
    });
    expect(server.config.igt.fields.state.tagset).toBe('Workflow');
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringMatching(/reserved Status value/),
      'Reserved value',
    );
    await view.unmount();
  });

  it('is reserved in the tagset editor, and a save that drops it writes nothing', async () => {
    const { server, client } = serverOf({ state: { tagset: 'Workflow', role: 'status' } });
    const workflow = {
      delimiters: '',
      mode: 'closed',
      values: [{ value: 'machine' }, { value: 'draft' }, { value: 'published' }],
    };
    server.config.igt.tagsets = { Workflow: workflow };
    const writes = [];
    client.batched = async (fn) => {
      fn({
        vocabLayers: {
          setConfig: (...a) => writes.push(a),
          deleteConfig: (...a) => writes.push(a),
        },
      });
      return [];
    };
    const view = await mount(client);
    expect(tagsetsManager.props.reservedValues).toEqual({ Workflow: ['published', 'machine'] });
    await expect(
      view.step(() =>
        tagsetsManager.props.onSaveChanges({
          Workflow: {
            ...workflow,
            values: [{ value: 'machine' }, { value: 'draft' }, { value: 'publicado' }],
          },
        }),
      ),
    ).rejects.toThrow(/“published” is a reserved Status value/);
    // The machine value a job writes is held the same way, in its own words.
    expect(tagsetsManager.props.reservedMessage('machine')).toBe(
      '“machine” is a reserved Status value and cannot be renamed or removed',
    );
    await expect(
      view.step(() =>
        tagsetsManager.props.onSaveChanges({
          Workflow: { ...workflow, values: [{ value: 'draft' }, { value: 'published' }] },
        }),
      ),
    ).rejects.toThrow(/“machine” is a reserved Status value/);
    expect(writes).toEqual([]);
    await view.unmount();
  });
});
