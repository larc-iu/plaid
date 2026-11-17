import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';
import { BUILT_IN_TABLE } from '@/domain/composeConfig';

// Settings → Text and vocab → Special characters: the list of a project's
// backslash codes, sortable by each column, with what was deleted gone.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const BUILT_IN_CODES = Object.keys(BUILT_IN_TABLE);
const byCode = (a, b) => a.localeCompare(b);

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// A project whose stored config the page writes into, read again on each save.
const open = async (compose) => {
  const server = { id: 'p-1', textLayers: [], config: { igt: compose ? { compose } : {} } };
  const client = {
    projects: {
      setConfig: async (_id, ns, key, value) => {
        server.config[ns][key] = structuredClone(value);
      },
    },
  };
  let view;
  const props = () => ({
    project: structuredClone(server),
    projectId: 'p-1',
    client,
    onProjectUpdate: () =>
      view.rerender(
        <MemoryRouter>
          <ComposeSettings {...props()} />
        </MemoryRouter>,
      ),
  });
  view = await renderComponent(
    <MemoryRouter>
      <ComposeSettings {...props()} />
    </MemoryRouter>,
  );
  const reopen = async () => {
    await view.unmount();
    view = await renderComponent(
      <MemoryRouter>
        <ComposeSettings {...props()} />
      </MemoryRouter>,
    );
    page.view = view;
  };
  const page = { server, view, reopen };
  return page;
};

const codes = (c) => [...c.querySelectorAll('[data-code-row]')].map((r) => r.dataset.codeRow);
const row = (c, code) => c.querySelector(`[data-code-row="${code}"]`);
const button = (c, name) =>
  [...c.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name || b.getAttribute('aria-label') === name,
  );
const header = (c, label) =>
  [...c.querySelectorAll('[data-compose-header] button')].find(
    (b) => b.textContent.trim() === label,
  );
const search = (view, text) =>
  view.step(() => type(view.container.querySelector('input[aria-label="Search codes"]'), text));
const save = async (page) =>
  page.view.step(async () => {
    button(page.view.container, 'Save').click();
    await settle();
  });

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('the labels', () => {
  it('heads the columns Code, Character, Note and Last modified', async () => {
    const { view } = await open();
    const heads = [...view.container.querySelectorAll('[data-compose-header] > *')].map((n) =>
      n.textContent.trim(),
    );
    expect(heads).toEqual(['Code', 'Character', 'Note', 'Last modified', '']);
    expect(view.container.textContent).not.toContain('Types');
    await view.unmount();
  });

  it('labels a row’s fields Code and Character', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const fresh = row(view.container, '');
    expect(fresh.querySelector('input[aria-label="Code"]')).not.toBeNull();
    expect(fresh.querySelector('input[aria-label="Character"]')).not.toBeNull();
    await search(view, 'sw');
    expect(row(view.container, 'sw').querySelector('input[aria-label="Character"]')).not.toBe(null);
    await view.unmount();
  });

  it('has no paragraph about the length of a code or Praat', async () => {
    const { view } = await open();
    const text = view.container.textContent;
    expect(text).not.toContain('A code is exactly');
    expect(text).not.toContain('never a space or a backslash');
    expect(text).not.toContain('built-in codes, taken from Praat');
    expect(text).not.toContain('a code you already know from there works here');
    await view.unmount();
  });

  it('puts no example text in a new row', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const fresh = row(view.container, '');
    for (const input of fresh.querySelectorAll('input')) {
      expect(input.getAttribute('placeholder') ?? '').toBe('');
    }
    expect(view.container.innerHTML).not.toContain('implosive b');
    await view.unmount();
  });

  it('says what an empty field needs only when it is wrong, in the fewest words', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const text = () => row(view.container, '').textContent;
    expect(view.container.textContent).not.toContain('Give the character this code types.');
    expect(text()).toContain('A code is 2 characters.');
    expect(text()).toContain('Enter a character.');
    await view.step(() => type(row(view.container, '').querySelector('input'), 'zq'));
    expect(row(view.container, 'zq').textContent).not.toContain('A code is 2 characters.');
    await view.unmount();
  });
});

describe('a new row given a built-in code', () => {
  it('keeps its code field and focus, and says the code exists', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const field = row(view.container, '').querySelector('input[aria-label="Code"]');
    field.focus();
    for (const typed of ['s', 'sw']) {
      await view.step(() => type(field, typed));
      expect(document.activeElement).toBe(field);
    }
    const fresh = field.closest('[data-code-row]');
    expect(fresh.dataset.codeRow).toBe('sw');
    expect(fresh.querySelector('input[aria-label="Code"]')).toBe(field);
    expect(fresh.textContent).toContain('This code already exists: \\sw is ə.');
    expect(fresh.querySelector('button[aria-label="Reset code sw"]')).toBeNull();
    await view.unmount();
  });

  it('is dropped when deleted, leaving the built-in as it was', async () => {
    const { view } = await open();
    await view.step(() => button(view.container, 'Add code').click());
    const field = row(view.container, '').querySelector('input[aria-label="Code"]');
    await view.step(() => type(field, 'sw'));
    await view.step(() =>
      field.closest('[data-code-row]').querySelector('button[aria-label="Delete code sw"]').click(),
    );
    expect(button(view.container, 'Restore built-in codes')).toBeUndefined();
    await search(view, 'sw');
    expect(view.container.querySelectorAll('[data-code-row="sw"]')).toHaveLength(1);
    expect(button(view.container, 'Save').disabled).toBe(true);
    await view.unmount();
  });
});

describe('a code that clashes with another', () => {
  // The new row, found by its editable Code field, and the other row of the
  // same code, which has none.
  const newRow = (c) => c.querySelector('input[aria-label="Code"]').closest('[data-code-row]');
  const builtInRowOf = (c, code) =>
    [...c.querySelectorAll(`[data-code-row="${code}"]`)].find(
      (r) => !r.querySelector('input[aria-label="Code"]'),
    );
  const typeNew = async (view, code, extra = {}) => {
    await view.step(() => button(view.container, 'Add code').click());
    const fresh = row(view.container, '');
    const field = fresh.querySelector('input[aria-label="Code"]');
    field.focus();
    await view.step(() => type(field, code));
    if (extra.char)
      await view.step(() => type(fresh.querySelector('input[aria-label="Character"]'), extra.char));
    if (extra.note)
      await view.step(() => type(fresh.querySelector('input[aria-label="Note"]'), extra.note));
    field.focus();
    return field;
  };
  const showIn = (r) => [...r.querySelectorAll('button')].find((b) => b.textContent === 'Show');

  it('names what the other code types, and its note cut short', async () => {
    const { view } = await open({
      codes: [{ code: 'ng', char: 'ŋ̊', description: 'voiceless eng, as in the 1992 survey' }],
      removed: [],
    });
    const field = await typeNew(view, 'ng');
    const text = newRow(view.container).textContent;
    expect(text).toContain('This code already exists: \\ng is ŋ̊ (voiceless eng, as in…).');
    expect(showIn(newRow(view.container))).toBeDefined();
    expect(document.activeElement).toBe(field);
    await view.unmount();
  });

  it('Show clears a search that hides the other row, scrolls to it, marks it and focuses it', async () => {
    const { view } = await open();
    await typeNew(view, 'sw', { note: 'mine' });
    await search(view, 'mine');
    expect(builtInRowOf(view.container, 'sw')).toBeUndefined();
    await view.step(() => showIn(newRow(view.container)).click());
    await view.step(settle);
    const target = builtInRowOf(view.container, 'sw');
    expect(target).toBeDefined();
    expect(view.container.querySelector('input[aria-label="Search codes"]').value).toBe('');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1)).toBe(target);
    expect(target.classList.contains('located-flash')).toBe(true);
    expect(document.activeElement).toBe(target.querySelector('input[aria-label="Character"]'));
    // Both ways out are on it.
    expect(target.querySelector('button[aria-label="Delete code sw"]')).not.toBeNull();
    await view.unmount();
  });

  it('works between two new rows', async () => {
    const { view } = await open();
    const first = await typeNew(view, 'qq', { char: 'x' });
    const second = await typeNew(view, 'qq', { char: 'y' });
    const rowOf = (field) => field.closest('[data-code-row]');
    expect(rowOf(second).textContent).toContain('This code already exists: \\qq is x.');
    expect(rowOf(first).textContent).toContain('This code already exists: \\qq is y.');
    await view.step(() => showIn(rowOf(second)).click());
    await view.step(settle);
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1)).toBe(rowOf(first));
    expect(document.activeElement).toBe(first);
    await view.unmount();
  });

  it('is no clash with a built-in the project deleted', async () => {
    const page = await open({ codes: [], removed: ['sw'] });
    const c = () => page.view.container;
    await typeNew(page.view, 'sw', { char: 'ɘ' });
    expect(c().textContent).not.toContain('This code already exists');
    expect(button(c(), 'Save').disabled).toBe(false);
    await save(page);
    await page.reopen();
    await search(page.view, 'sw');
    const rows = [...c().querySelectorAll('[data-code-row="sw"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('input[aria-label="Character"]').value).toBe('ɘ');
    expect(c().textContent).not.toContain('This code already exists');
    await page.view.unmount();
  });
});

describe('sorting', () => {
  const dated = {
    codes: [
      { code: 'sw', char: 'ɚ', modified: '2026-11-01T10:00:00.000Z' },
      { code: "b'", char: 'ɓ', description: 'mine', modified: '2026-11-03T10:00:00.000Z' },
      { code: 'ng', char: 'ŋ̊', modified: '2026-11-02T10:00:00.000Z' },
    ],
    removed: [],
  };

  it('opens with the most recently modified first, then the rest by code', async () => {
    const { view } = await open(dated);
    const shown = codes(view.container);
    expect(shown.slice(0, 3)).toEqual(["b'", 'ng', 'sw']);
    const rest = BUILT_IN_CODES.filter((c) => c !== 'sw' && c !== 'ng').sort(byCode);
    expect(shown.slice(3)).toEqual(rest.slice(0, shown.length - 3));
    await view.unmount();
  });

  it('shows a modified time in relative form with the full time on hover, a built-in none', async () => {
    const { view } = await open(dated);
    const cell = row(view.container, "b'").querySelector('[data-modified]');
    expect(cell.textContent).toMatch(/ago|yesterday|last|week|month|day/);
    expect(cell.getAttribute('title')).toBe(new Date('2026-11-03T10:00:00.000Z').toLocaleString());
    const untouched = codes(view.container)[3];
    expect(row(view.container, untouched).querySelector('[data-modified]').textContent).toBe('');
    await view.unmount();
  });

  it('puts the never-modified first when Last modified is ascending', async () => {
    const { view } = await open(dated);
    await view.step(() => header(view.container, 'Last modified').click());
    const shown = codes(view.container);
    const blanks = BUILT_IN_CODES.filter((c) => c !== 'sw' && c !== 'ng').sort(byCode);
    expect(shown).toEqual(blanks.slice(0, shown.length));
    await view.unmount();
  });

  it('sorts by code both ways', async () => {
    const { view } = await open();
    const all = [...BUILT_IN_CODES].sort(byCode);
    await view.step(() => header(view.container, 'Code').click());
    expect(codes(view.container)).toEqual(all.slice(0, 25));
    await view.step(() => header(view.container, 'Code').click());
    expect(codes(view.container)).toEqual([...all].reverse().slice(0, 25));
    await view.unmount();
  });

  it('sorts by character', async () => {
    const { view } = await open();
    await view.step(() => header(view.container, 'Character').click());
    const chars = codes(view.container).map(
      (c) => row(view.container, c).querySelector('input[aria-label="Character"]').value,
    );
    expect(chars).toEqual([...chars].sort((a, b) => a.localeCompare(b)));
    await view.unmount();
  });

  it('sorts by note, a blank note smallest', async () => {
    const { view } = await open(dated);
    await view.step(() => header(view.container, 'Note').click());
    expect(codes(view.container)[0]).not.toBe("b'");
    await view.step(() => header(view.container, 'Note').click());
    expect(codes(view.container)[0]).toBe("b'");
    await view.unmount();
  });

  it('keeps a row in place while it is edited', async () => {
    const { view } = await open(dated);
    await view.step(() => header(view.container, 'Character').click());
    const before = codes(view.container);
    const field = row(view.container, before[2]).querySelector('input[aria-label="Character"]');
    await view.step(() => type(field, 'zzz'));
    expect(codes(view.container)).toEqual(before);
    await view.unmount();
  });
});

describe('a deleted built-in code', () => {
  it('leaves no row', async () => {
    const { view } = await open({ codes: [], removed: ['sw'] });
    await view.step(() => header(view.container, 'Code').click());
    await search(view, 'sw');
    expect(row(view.container, 'sw')).toBeNull();
    expect(view.container.textContent).not.toContain('Taken out of this project');
    expect(view.container.textContent).not.toContain('Removed');
    await view.unmount();
  });

  it('goes at once, and stays gone once saved and read again', async () => {
    const page = await open();
    const c = () => page.view.container;
    await search(page.view, 'sw');
    expect(row(c(), 'sw')).not.toBeNull();
    await page.view.step(() => button(c(), 'Delete code sw').click());
    expect(row(c(), 'sw')).toBeNull();
    await save(page);
    expect(page.server.config.igt.compose.removed).toEqual(['sw']);
    await page.reopen();
    await search(page.view, 'sw');
    expect(c().querySelector('[data-code-row]')).not.toBeNull();
    expect(row(c(), 'sw')).toBeNull();
    await page.view.unmount();
  });

  it('comes back with the others from Restore built-in codes', async () => {
    const page = await open({ codes: [], removed: ['sw', 'ng'] });
    const c = () => page.view.container;
    await page.view.step(() => header(c(), 'Code').click());
    await page.view.step(() => button(c(), 'Restore built-in codes').click());
    expect(button(c(), 'Restore built-in codes')).toBeUndefined();
    await save(page);
    expect(page.server.config.igt.compose.removed).toEqual([]);
    await search(page.view, 'sw');
    expect(row(c(), 'sw')).not.toBeNull();
    await page.view.unmount();
  });

  it('offers no restore when nothing was deleted', async () => {
    const { view } = await open();
    expect(button(view.container, 'Restore built-in codes')).toBeUndefined();
    await view.unmount();
  });
});

describe('the time a code was last changed', () => {
  it('is stored with a changed code on save, and an untouched one stores nothing', async () => {
    const page = await open({
      codes: [{ code: 'ng', char: 'ŋ̊', modified: '2026-01-01T00:00:00.000Z' }],
      removed: [],
    });
    const c = () => page.view.container;
    await page.view.step(() => header(c(), 'Code').click());
    const before = Date.now();
    const code = codes(c())[0];
    await page.view.step(() =>
      type(row(c(), code).querySelector('input[aria-label="Character"]'), 'X'),
    );
    await save(page);
    const stored = page.server.config.igt.compose.codes;
    const first = stored.find((r) => r.code === code);
    expect(Date.parse(first.modified)).toBeGreaterThanOrEqual(before);
    // The list shows what was stored, time and all, with nothing left to save.
    expect(button(c(), 'Save').disabled).toBe(true);
    expect(row(c(), code).querySelector('[data-modified]').textContent).not.toBe('');
    // A code nobody touched in this save keeps the time it had.
    expect(stored.find((r) => r.code === 'ng').modified).toBe('2026-01-01T00:00:00.000Z');
    expect(stored).toHaveLength(2);
    await page.view.unmount();
  });
});

describe('the row layout', () => {
  // happy-dom draws nothing, so this pins the structure the layout rests on:
  // every row and the header share one grid, each cell its own track, and the
  // buttons sit in their own last cell, never beside or over the note field.
  it('gives every row the header’s five cells, the buttons in the last', async () => {
    const { view } = await open({
      codes: [
        { code: ':f', char: 'ː', description: 'IPA length', modified: '2026-11-01T00:00:00Z' },
      ],
      removed: [],
    });
    const head = view.container.querySelector('[data-compose-header]');
    const grids = [...view.container.querySelectorAll('[data-code-row] > [data-compose-grid]')];
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.className).toBe(head.className);
      expect(grid.children).toHaveLength(5);
      const [, , note, , actions] = grid.children;
      expect(note.querySelector('button')).toBeNull();
      expect(actions.querySelector('input')).toBeNull();
    }
    const changed = row(view.container, ':f').querySelector('[data-compose-grid]');
    expect(changed.children[4].querySelectorAll('button')).toHaveLength(2);
    expect(view.container.textContent).not.toContain('Changed');
    await view.unmount();
  });
});

// H11-3: the list, the clash message and the guide write a code with its
// backslash, so a search typed that way finds it.
describe('search', () => {
  it('finds a code typed with its backslash, as without', async () => {
    const { view } = await open();
    await search(view, '\\sw');
    const withSlash = codes(view.container);
    expect(withSlash).toContain('sw');
    await search(view, 'sw');
    expect(codes(view.container)).toEqual(withSlash);
    await view.unmount();
  });
});

// H11-2: an edit not saved yet is asked about before the section is left.
describe('an edit not saved yet', () => {
  it('stands as unsaved until it is saved', async () => {
    const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');
    const page = await open();
    const { view } = page;
    await search(view, 'sw');
    const char = row(view.container, 'sw').querySelector('input[aria-label="Character"]');
    expect(hasUnsavedDraft()).toBeNull();
    await view.step(() => type(char, 'Ə'));
    expect(hasUnsavedDraft()).toBe('The special characters you have changed');
    await save(page);
    expect(hasUnsavedDraft()).toBeNull();
    await view.unmount();
  });
});
