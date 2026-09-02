import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts } from '@/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager.jsx';
import { TagsetsManager, PAGE_SIZE } from './TagsetsManager.jsx';
import { byTagsetName, governedFields } from '@/domain/tagsets.js';
import { notifyInfo, notifyError } from '@/utils/feedback';

// The settings surface around tagsets. Every case here is a bug that was found
// by hand rather than by a test: a column that never appeared, a button that
// was clickable and did nothing, and controls sitting in the wrong cell so a
// new column landed to their right.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const FIELDS = {
  fields: [
    { name: 'Gloss', scope: 'Morpheme', isCustom: false, tagset: 'Leipzig' },
    { name: 'POS', scope: 'Word', isCustom: false, tagset: null },
  ],
  ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [] },
};

const headers = (c) => texts(c, 'thead th');

// React tracks a controlled input's value, so assigning .value directly does
// not fire onChange. Go through the native setter the way React's own test
// utilities do.
const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// A tagset panel renders its body only when expanded.
const expandFirst = async (container, step) => {
  const toggle = all(container, 'button').find((b) => b.title === 'Expand');
  await step(async () => toggle.click());
};

describe('FieldsManager tagset column', () => {
  it('appears as soon as the project has a tagset', async () => {
    // It never appeared at all: FieldsSettings loaded the names once on mount,
    // the tagset was created afterwards in the section above, and nothing told
    // it. The names are a prop now, so this is the contract that keeps it live.
    const { container, unmount } = await renderComponent(
      <FieldsManager initialData={FIELDS} tagsetNames={['Leipzig']} />,
    );
    expect(headers(container)).toContain('Tagset');
    await unmount();
  });

  it('stays hidden when there are none, so the setup wizard is not cluttered', async () => {
    const { container, unmount } = await renderComponent(
      <FieldsManager initialData={FIELDS} tagsetNames={[]} />,
    );
    expect(headers(container)).not.toContain('Tagset');
    await unmount();
  });

  it('sits to the LEFT of the row controls', async () => {
    // The controls used to live inside the Field Name cell, pinned right by
    // justify-between, so any column added after them rendered to their right.
    const { container, unmount } = await renderComponent(
      <FieldsManager initialData={FIELDS} tagsetNames={['Leipzig']} />,
    );
    const cells = all(container, 'tbody tr:first-child td');
    const tagsetCell = cells.findIndex((td) => td.querySelector('[role="combobox"], select'));
    const controlCell = cells.findIndex((td) => td.querySelector('button[title="Remove"]'));
    expect(tagsetCell).toBeGreaterThan(-1);
    expect(controlCell).toBeGreaterThan(-1);
    expect(tagsetCell).toBeLessThan(controlCell);
    await unmount();
  });

  it('links a violation count into the Validation tab', async () => {
    // The badge is the discovery path: without it nothing tells you to go and
    // look, and the count is only meaningful if you can act on it.
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <FieldsManager
          initialData={FIELDS}
          tagsetNames={['Leipzig']}
          projectId="p-1"
          violations={{ 'morpheme:Gloss': 4 }}
        />
      </MemoryRouter>,
    );
    const link = all(container, 'a').find((a) => a.textContent.includes('outside the tagset'));
    expect(link).toBeTruthy();
    expect(link.textContent).toContain('4');
    expect(link.getAttribute('href')).toContain('tab=validate');
    await unmount();
  });

  it('shows no badge for a field whose values are all in its tagset', async () => {
    const { container, unmount } = await renderComponent(
      <MemoryRouter>
        <FieldsManager initialData={FIELDS} tagsetNames={['Leipzig']} violations={{}} />
      </MemoryRouter>,
    );
    expect(container.textContent).not.toContain('outside the tagset');
    await unmount();
  });

  it('keeps a dangling tagset name visible rather than reading as "none"', async () => {
    const data = { ...FIELDS, fields: [{ ...FIELDS.fields[0], tagset: 'Deleted' }] };
    const { container, unmount } = await renderComponent(
      <FieldsManager initialData={data} tagsetNames={['Leipzig']} />,
    );
    expect(container.textContent).toContain('Deleted');
    await unmount();
  });
});

describe('TagsetsManager', () => {
  const tagsets = { Leipzig: { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }] } };

  // Build `usage` the way the app does, from governedFields, rather than by
  // hand. Hand-built records are what let the manager keep reading `f.name`
  // after the consolidation renamed it to `field`: the tests passed while every
  // "used by" line on screen said "undefined".
  const usageFor = (scope, fieldName, mode = 'closed') =>
    byTagsetName(
      governedFields(
        {
          spanLayers: {
            [scope]: [{ id: 'l-1', name: fieldName, config: { igt: { tagset: 'Leipzig' } } }],
          },
        },
        { igt: { tagsets: { Leipzig: { ...tagsets.Leipzig, mode } } } },
      ),
    );
  const render = (usage = {}) =>
    renderComponent(
      <TagsetsManager
        tagsets={tagsets}
        usage={usage}
        onSaveChanges={vi.fn()}
        onLoadAttested={vi.fn(async () => [])}
      />,
    );

  const seedButton = (c) =>
    all(c, 'button').find((b) => b.textContent.includes('Add values used in this project'));

  it('disables the seed button when no field uses the tagset', async () => {
    // It was clickable and did nothing: the values it reads come from the
    // fields USING the tagset, and there were none.
    const { container, step, unmount } = await render({});
    await expandFirst(container, step);
    expect(seedButton(container).disabled).toBe(true);
    expect(seedButton(container).title).toMatch(/No annotation field uses this tagset/);
    await unmount();
  });

  it('enables it once a field points at the tagset', async () => {
    const { container, step, unmount } = await render(usageFor('morpheme', 'Gloss'));
    await expandFirst(container, step);
    expect(seedButton(container).disabled).toBe(false);
    // The usage line names the field. It said "undefined (morpheme)" for as
    // long as the manager read the pre-consolidation key.
    expect(container.textContent).toContain('Gloss (morpheme)');
    await unmount();
  });

  it('survives adding a tagset', async () => {
    // Add Tagset built a record with no `mode`, and the badge lookup
    // MODES_UI[undefined].badge threw, unmounting the whole section.
    const { container, step, unmount } = await renderComponent(
      <TagsetsManager
        tagsets={{}}
        usage={{}}
        onSaveChanges={vi.fn()}
        onLoadAttested={vi.fn(async () => [])}
      />,
    );
    const input = container.querySelector('input');
    await step(async () => typeInto(input, 'Leipzig'));
    const add = all(container, 'button').find((b) => b.textContent.includes('Add Tagset'));
    await step(async () => add.click());
    expect(container.textContent).toContain('Leipzig');
    expect(container.textContent).toContain('Suggested');
    await unmount();
  });

  describe('a large value list', () => {
    // A seeded Leipzig tagset runs past a thousand values.
    const COUNT = PAGE_SIZE * 4 + 20; // several pages, last one partial
    const big = {
      Leipzig: {
        delimiters: '.',
        mode: 'closed',
        values: Array.from({ length: COUNT }, (_, i) => ({ value: `V${i}` })),
      },
    };
    const renderBig = (onSaveChanges = vi.fn()) =>
      renderComponent(
        <TagsetsManager
          tagsets={big}
          usage={{}}
          onSaveChanges={onSaveChanges}
          onLoadAttested={vi.fn(async () => [])}
        />,
      );
    const rowValues = (c) =>
      all(c, 'tbody tr td:nth-child(2) input').map((i) => i.getAttribute('value') ?? i.value);
    const click = (c, step, label) =>
      step(async () =>
        all(c, 'button')
          .find((b) => b.textContent.trim() === label)
          .click(),
      );

    it('shows one page at a time instead of every value', async () => {
      const { container, step, unmount } = await renderBig();
      await expandFirst(container, step);
      expect(rowValues(container)).toHaveLength(PAGE_SIZE);
      expect(container.textContent).toContain('page 1 of 5');
      await unmount();
    });

    it('edits the right value on a later page, not the row with the same position', async () => {
      // The rows carry their index in the FULL list; slicing would otherwise
      // make row 1 of page 2 edit value 0.
      const onSaveChanges = vi.fn();
      const { container, step, unmount } = await renderBig(onSaveChanges);
      await expandFirst(container, step);
      await click(container, step, 'Next');
      expect(rowValues(container)[0]).toBe(`V${PAGE_SIZE}`);
      await step(async () => all(container, 'button[title="Remove value"]')[0].click());
      const saved = onSaveChanges.mock.calls.at(-1)[0].Leipzig.values.map((v) => v.value);
      expect(saved).toHaveLength(COUNT - 1);
      expect(saved).not.toContain(`V${PAGE_SIZE}`);
      expect(saved).toContain('V0');
      await unmount();
    });

    it('searches the whole list, not just the page on screen', async () => {
      const { container, step, unmount } = await renderBig();
      await expandFirst(container, step);
      const search = all(container, 'input').find((i) =>
        (i.getAttribute('placeholder') || '').startsWith('Search'),
      );
      await step(async () => typeInto(search, 'V11'));
      // V11 plus V110..V119 all live well past the first page.
      expect(rowValues(container)).toContain('V119');
      expect(container.textContent).toContain(`11 of ${COUNT}`);
      await unmount();
    });

    it('says so when a search matches nothing', async () => {
      const { container, step, unmount } = await renderBig();
      await expandFirst(container, step);
      const search = all(container, 'input').find((i) =>
        (i.getAttribute('placeholder') || '').startsWith('Search'),
      );
      await step(async () => typeInto(search, 'zzz'));
      expect(container.textContent).toContain('No value matches');
      await unmount();
    });
  });

  it('warns that a word-scope field needs the affix joiners', async () => {
    // dog-PL is one part without "-", and mixed mode waves it through on the
    // lowercase in "dog" without ever checking PL.
    const mixed = { Leipzig: { delimiters: '.', mode: 'mixed', values: [] } };
    const { container, step, unmount } = await renderComponent(
      <TagsetsManager
        tagsets={mixed}
        usage={usageFor('word', 'Gloss', 'mixed')}
        onSaveChanges={vi.fn()}
        onLoadAttested={vi.fn(async () => [])}
      />,
    );
    await expandFirst(container, step);
    expect(container.textContent).toContain('dog-PL');
    expect(all(container, 'button').some((b) => b.textContent.includes('Add - and ='))).toBe(true);
    await unmount();
  });

  it('does not warn when only morpheme-scope fields use it', async () => {
    const mixed = { Leipzig: { delimiters: '.', mode: 'mixed', values: [] } };
    const { container, step, unmount } = await renderComponent(
      <TagsetsManager
        tagsets={mixed}
        usage={usageFor('morpheme', 'Gloss', 'mixed')}
        onSaveChanges={vi.fn()}
        onLoadAttested={vi.fn(async () => [])}
      />,
    );
    await expandFirst(container, step);
    expect(container.textContent).not.toContain('dog-PL');
    await unmount();
  });
});

describe('TagsetsManager: rename, seed and value rows', () => {
  const leipzig = { delimiters: '.', mode: 'suggest', values: [{ value: 'PL' }] };
  const usage = byTagsetName(
    governedFields(
      {
        spanLayers: {
          morpheme: [{ id: 'l-1', name: 'Gloss', config: { igt: { tagset: 'Leipzig' } } }],
        },
      },
      { igt: { tagsets: { Leipzig: leipzig } } },
    ),
  );
  const mountWith = (props = {}) =>
    renderComponent(
      <TagsetsManager
        tagsets={{ Leipzig: leipzig }}
        usage={usage}
        onSaveChanges={vi.fn()}
        onLoadAttested={vi.fn(async () => [])}
        {...props}
      />,
    );
  const button = (c, label) =>
    all(c, 'button').find((b) => b.textContent.replace(/\s+/g, ' ').trim().startsWith(label));
  const rowInputs = (c) => all(c, 'tbody tr td:nth-child(2) input');
  const savedValues = (spy) => spy.mock.calls.at(-1)[0].Leipzig.values.map((v) => v.value);
  // React's onBlur listens for focusout. The inputs are uncontrolled, so the
  // value is assigned directly, as a person's typing would leave it.
  const blurWith = (input, value) => {
    input.value = value;
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  };

  it('hands a rename to the wrapper with both names, and says the fields moved with it', async () => {
    // Fields reference a tagset by name. The wrapper repoints them, so the
    // rename has to travel with the save rather than as a toast telling the
    // user to do it by hand.
    vi.clearAllMocks();
    const onSaveChanges = vi.fn();
    const { container, step, unmount } = await mountWith({ onSaveChanges });
    await expandFirst(container, step);
    const name = all(container, 'input').find((i) => i.value === 'Leipzig');
    await step(async () => blurWith(name, 'Leipzig 2'));
    expect(onSaveChanges).toHaveBeenCalledWith(
      expect.objectContaining({ 'Leipzig 2': expect.anything() }),
      { renamed: { from: 'Leipzig', to: 'Leipzig 2' } },
    );
    expect(notifyInfo).toHaveBeenCalledWith(
      expect.stringContaining('now points at "Leipzig 2"'),
      'Tagset Renamed',
    );
    await unmount();
  });

  it('holds lowercase values back for a decision when seeding', async () => {
    // A glossed project has far more stems than tags. Seeding them all under
    // the default (suggest) mode is how a tagset came to hold 1,700 values.
    const onSaveChanges = vi.fn();
    const onLoadAttested = vi.fn(async () => [
      ['dog.PL', 5],
      ['run.PST', 2],
    ]);
    const { container, step, unmount } = await mountWith({ onSaveChanges, onLoadAttested });
    await expandFirst(container, step);
    await step(async () => button(container, 'Add values used in this project').click());
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(container.textContent).toContain('1 tag and 2 values with a lowercase letter');
    expect(container.textContent).toContain('dog, run');
    await step(async () => button(container, 'Add 1 tag').click());
    expect(savedValues(onSaveChanges)).toEqual(['PL', 'PST']);
    await unmount();
  });

  it('can still take everything, for a lowercase inventory like part of speech', async () => {
    const onSaveChanges = vi.fn();
    const onLoadAttested = vi.fn(async () => [
      ['dog.PL', 5],
      ['run.PST', 2],
    ]);
    const { container, step, unmount } = await mountWith({ onSaveChanges, onLoadAttested });
    await expandFirst(container, step);
    await step(async () => button(container, 'Add values used in this project').click());
    await step(async () => button(container, 'Add all 3').click());
    expect(savedValues(onSaveChanges)).toEqual(['PL', 'PST', 'dog', 'run']);
    await unmount();
  });

  it('seeds straight away when everything found is a tag', async () => {
    const onSaveChanges = vi.fn();
    const onLoadAttested = vi.fn(async () => [['1SG.NOM', 3]]);
    const { container, step, unmount } = await mountWith({ onSaveChanges, onLoadAttested });
    await expandFirst(container, step);
    await step(async () => button(container, 'Add values used in this project').click());
    expect(container.textContent).not.toContain('with a lowercase letter');
    expect(savedValues(onSaveChanges)).toEqual(['PL', '1SG', 'NOM']);
    await unmount();
  });

  it('offers to drop the lowercase values a mixed tagset accepts anyway', async () => {
    const onSaveChanges = vi.fn();
    const mixed = {
      Leipzig: {
        delimiters: '.',
        mode: 'mixed',
        values: [{ value: 'PL' }, { value: 'dog' }, { value: 'run' }],
      },
    };
    const { container, step, unmount } = await mountWith({ tagsets: mixed, onSaveChanges });
    await expandFirst(container, step);
    expect(container.textContent).toContain('2 listed values contain a lowercase letter');
    await step(async () => button(container, 'Remove them').click());
    expect(savedValues(onSaveChanges)).toEqual(['PL']);
    await unmount();
  });

  it('says nothing about lowercase values outside mixed mode, where they do real work', async () => {
    const pos = { Leipzig: { delimiters: '', mode: 'closed', values: [{ value: 'n' }] } };
    const { container, step, unmount } = await mountWith({ tagsets: pos });
    await expandFirst(container, step);
    expect(container.textContent).not.toContain('contains a lowercase letter');
    await unmount();
  });

  it('keeps each row showing its own value after the row above it is removed', async () => {
    // The row inputs are uncontrolled. Keyed by position, a removal handed
    // row 1's DOM node (text and all) to the record that slid into slot 1.
    const onSaveChanges = vi.fn();
    const three = {
      Leipzig: {
        delimiters: '',
        mode: 'closed',
        values: ['V0', 'V1', 'V2'].map((value) => ({ value })),
      },
    };
    const { container, step, unmount } = await mountWith({ tagsets: three, onSaveChanges });
    await expandFirst(container, step);
    // Touch row 1 so its node is "dirty", the state in which a browser stops
    // following defaultValue.
    await step(async () => blurWith(rowInputs(container)[1], 'V1'));
    await step(async () => all(container, 'button[title="Remove value"]')[0].click());
    expect(rowInputs(container).map((i) => i.value)).toEqual(['V1', 'V2']);
    await unmount();
  });

  it('refuses renaming a value to one already listed', async () => {
    // The duplicate would be dropped on the next read, description and all.
    vi.clearAllMocks();
    const onSaveChanges = vi.fn();
    const two = {
      Leipzig: { delimiters: '', mode: 'closed', values: [{ value: 'PL' }, { value: 'NOM' }] },
    };
    const { container, step, unmount } = await mountWith({ tagsets: two, onSaveChanges });
    await expandFirst(container, step);
    const first = rowInputs(container)[0];
    await step(async () => blurWith(first, 'NOM'));
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('NOM'), 'Duplicate Value');
    expect(first.value).toBe('PL');
    await unmount();
  });
});
