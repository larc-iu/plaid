import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Each field's Lexicon field: the entry field its values pair with, chosen
// from the entry fields of the project's vocabularies, saved on its own, and
// proposed by a new field's name once.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
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
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

const { FieldsSettings } = await import('./FieldsSettings.jsx');
const { FieldsManager } = await import('./FieldsManager.jsx');
const { fieldChange } = await import('./fieldChange.js');

const role = (r) => ({ plaid: { role: r } });
const layer = (id, name, igt = {}) => ({
  id,
  name,
  config: { igt: { scope: 'Morpheme', ...igt } },
});
const project = () => ({
  id: 'p1',
  config: {},
  vocabs: [
    { id: 'v1', config: { igt: { fields: { gloss: { inline: true }, meaning: {} } } } },
    { id: 'v2', config: { igt: { fields: { category: {} } } } },
  ],
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        { id: 'sent', config: role('sentence'), spanLayers: [] },
        { id: 'word', config: role('word'), spanLayers: [] },
        {
          id: 'morph',
          config: role('morpheme'),
          spanLayers: [layer('gloss', 'Gloss'), layer('pos', 'POS', { lexiconField: 'category' })],
        },
      ],
    },
  ],
});

const fakeClient = () => {
  const writes = [];
  const bundle = () => ({
    tokenLayers: { setConfig: (...a) => writes.push(['tokenLayers.setConfig', ...a]) },
    spanLayers: {
      setConfig: (...a) => writes.push(['spanLayers.setConfig', ...a]),
      deleteConfig: (...a) => writes.push(['spanLayers.deleteConfig', ...a]),
      delete: (...a) => writes.push(['spanLayers.delete', ...a]),
    },
  });
  return {
    writes,
    projects: { get: async () => project() },
    ...bundle(),
    batched: async (fn) => {
      fn(bundle());
      return [];
    },
    query: async () => ({ results: [[0]] }),
  };
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// The Lexicon field select on a field's row.
const selectOf = (name) =>
  all(document.body, 'tbody tr')
    .find((tr) => tr.querySelector('td:nth-child(2)').textContent.trim() === name)
    .querySelector('select');
const optionText = (select) => select.options[select.selectedIndex].textContent;
const choose = async (step, name, text) => {
  const select = selectOf(name);
  const option = [...select.options].find((o) => o.textContent === text);
  await step(async () => {
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
};

afterEach(() => vi.clearAllMocks());

describe('Settings > Fields > Lexicon field', () => {
  it('shows what each field records, a field named Gloss with none included', async () => {
    const view = await renderComponent(
      <FieldsSettings project={project()} projectId="p1" client={fakeClient()} />,
    );
    await view.step(async () => {});
    expect(optionText(selectOf('Gloss'))).toBe('None');
    expect(optionText(selectOf('POS'))).toBe('Category');
    expect([...selectOf('Gloss').options].map((o) => o.textContent)).toEqual([
      'None',
      'Morph Type',
      'Gloss',
      'Meaning',
      'Category',
    ]);
    await view.unmount();
  });

  it('writes the entry field chosen, and clears it on None', async () => {
    const client = fakeClient();
    const view = await renderComponent(
      <FieldsSettings project={project()} projectId="p1" client={client} />,
    );
    await view.step(async () => {});
    await choose(view.step, 'Gloss', 'Meaning');
    expect(client.writes).toEqual([
      ['spanLayers.setConfig', 'gloss', 'igt', 'lexiconField', 'meaning', undefined, {}],
    ]);
    client.writes.length = 0;
    await choose(view.step, 'POS', 'None');
    expect(client.writes).toEqual([
      [
        'spanLayers.deleteConfig',
        'pos',
        'igt',
        'lexiconField',
        undefined,
        { expected: 'category' },
      ],
    ]);
    await view.unmount();
  });

  it('a new field takes the Lexicon field its name proposes', async () => {
    const saves = [];
    const view = await renderComponent(
      <FieldsManager
        initialData={{ fields: [], ignoredTokens: null }}
        onSaveChanges={async (d) => saves.push(d)}
        projectId="p1"
      />,
    );
    const input = document.querySelector('input[placeholder="Enter field name"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await view.step(() => {
      setter.call(input, 'Gloss');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    });
    expect(saves.at(-1).fields).toEqual([
      expect.objectContaining({ name: 'Gloss', scope: 'Word', lexiconField: 'gloss' }),
    ]);
    await view.unmount();
  });
});

describe('fieldChange', () => {
  it('lists the fields whose Lexicon field changed, and every new one', () => {
    const was = [
      { name: 'Gloss', scope: 'Morpheme', lexiconField: 'gloss' },
      { name: 'POS', scope: 'Morpheme', lexiconField: null },
    ];
    const now = [
      { name: 'Gloss', scope: 'Morpheme', lexiconField: null },
      { name: 'POS', scope: 'Morpheme', lexiconField: null },
      { name: 'Note', scope: 'Word', lexiconField: null },
    ];
    const change = fieldChange({
      fields: now,
      ignoredTokens: null,
      previous: { fields: was, ignoredTokens: null },
    });
    expect(change.lexiconField.map((f) => f.name)).toEqual(['Gloss', 'Note']);
  });
});
