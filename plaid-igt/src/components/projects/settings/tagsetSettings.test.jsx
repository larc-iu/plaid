import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts } from '@/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager.jsx';
import { TagsetsManager } from './TagsetsManager.jsx';
import { byTagsetName, governedFields } from '@/domain/tagsets.js';

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
