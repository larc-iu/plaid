import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A sentence field's role: what it holds (its translation, literal
// translation or a note), shown and chosen on its row, saved on its own, and
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

const role = (r) => ({ plaid: { role: r } });
const layer = (id, name, igt = {}) => ({
  id,
  name,
  config: { igt: { scope: 'Sentence', ...igt } },
});
const project = () => ({
  id: 'p1',
  config: {},
  vocabs: [],
  textLayers: [
    {
      id: 'text',
      config: role('baseline'),
      tokenLayers: [
        {
          id: 'sent',
          config: role('sentence'),
          spanLayers: [
            layer('free', 'Libre', { sentenceRole: 'translation' }),
            layer('trans', 'Translation'),
          ],
        },
        { id: 'word', config: role('word'), spanLayers: [] },
        { id: 'morph', config: role('morpheme'), spanLayers: [] },
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

describe('Settings > Fields > Role', () => {
  it('shows the role each sentence field records, a field named Translation with none included', async () => {
    const view = await renderComponent(
      <FieldsSettings project={project()} projectId="p1" client={fakeClient()} />,
    );
    await view.step(async () => {});
    expect(optionText(selectOf('Libre'))).toBe('Translation');
    expect(optionText(selectOf('Translation'))).toBe('None');
    expect([...selectOf('Libre').options].map((o) => o.textContent)).toEqual([
      'None',
      'Translation',
      'Literal translation',
      'Note',
    ]);
    await view.unmount();
  });

  it('writes the role chosen, and clears it on None', async () => {
    const client = fakeClient();
    const view = await renderComponent(
      <FieldsSettings project={project()} projectId="p1" client={client} />,
    );
    await view.step(async () => {});
    await choose(view.step, 'Translation', 'Note');
    expect(client.writes).toEqual([
      ['spanLayers.setConfig', 'trans', 'igt', 'sentenceRole', 'note', undefined, {}],
    ]);
    client.writes.length = 0;
    await choose(view.step, 'Libre', 'None');
    expect(client.writes).toEqual([
      [
        'spanLayers.deleteConfig',
        'free',
        'igt',
        'sentenceRole',
        undefined,
        { expected: 'translation' },
      ],
    ]);
    await view.unmount();
  });

  it('a new sentence field takes the role its name proposes', async () => {
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
    // The scope picker is the select beside the name box.
    const scope = input.parentElement.querySelector('select');
    await view.step(async () => {
      scope.value = 'Sentence';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
    });
    await view.step(() => {
      setter.call(input, 'Free translation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    });
    expect(saves.at(-1).fields).toEqual([
      expect.objectContaining({
        name: 'Free translation',
        scope: 'Sentence',
        sentenceRole: 'translation',
      }),
    ]);
    await view.unmount();
  });
});
