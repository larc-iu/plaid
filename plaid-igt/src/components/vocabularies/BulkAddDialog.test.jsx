import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e, fallback) => e?.message || fallback,
}));

// The entries as the server has them when Import reads them again.
let stored = [];
vi.mock('@/domain/vocabCache', () => ({
  readVocabulary: async () => ({ items: stored }),
}));

const { BulkAddDialog } = await import('./BulkAddDialog.jsx');

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const FIELDS = [
  { name: 'gloss', type: 'text' },
  { name: 'source', type: 'text' },
];

const open = async ({
  existingItems = [],
  bulkCreate = vi.fn(async () => {}),
  onImported,
  onOpenChange = () => {},
  fields = FIELDS,
} = {}) => {
  const client = { vocabItems: { bulkCreate, bulkUpdate: vi.fn(async () => {}) } };
  const send = async (_label, write) => {
    try {
      await write(() => {});
      return { landed: true };
    } catch (error) {
      return { landed: false, error };
    }
  };
  const view = await renderComponent(
    <BulkAddDialog
      open
      onOpenChange={onOpenChange}
      vocabularyId="v1"
      vocabularyName="Words"
      fields={fields}
      existingItems={existingItems}
      client={client}
      send={send}
      onImported={onImported ?? (async () => {})}
    />,
  );
  return { view, client };
};

const paste = async (view, text) => {
  await view.step(() => setValue(document.querySelector('textarea'), text));
  await view.step(() => button('Next: columns').click());
};

let mounted = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  stored = [];
});

describe('Bulk Add', () => {
  it('starts the table below the rows above its header, and can be told another row', async () => {
    const { view } = await open();
    mounted = view;
    await paste(view, 'Column1\tColumn2\nform\tgloss\nperro\tdog\nchat\tcat');
    const start = document.querySelector('input[type="number"]');
    expect(start.value).toBe('2');
    expect(document.body.textContent).toContain('1 row above it is left out');
    await view.step(() => button('Next: review').click());
    expect(button('Add 2')).toBeTruthy();
    // Told the table starts on the first row, it reads that row as data.
    await view.step(() => button('Back').click());
    const box = () => document.querySelector('input[type="number"]');
    // Typed digits wait for Enter or a click elsewhere.
    await view.step(() => setValue(box(), ''));
    expect(document.body.textContent).toContain('left out');
    await view.step(() => setValue(box(), '1'));
    await view.step(() => box().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(document.body.textContent).not.toContain('left out');
  });

  it('gives every row the same value for a field no column supplies', async () => {
    const bulkCreate = vi.fn(async () => {});
    const { view } = await open({ bulkCreate });
    mounted = view;
    await paste(view, 'form\tgloss\nperro\tdog\nchat\tcat');
    const add = all(document.body, 'select').find((s) => s.textContent.includes('Add a field…'));
    await view.step(() => setValue(add, 'source'));
    await view.step(() =>
      setValue(document.querySelector('input[aria-label="Source on every row"]'), 'Word list'),
    );
    await view.step(() => button('Next: review').click());
    await view.step(async () => {
      button('Add 2').click();
      await settle();
    });
    const sent = bulkCreate.mock.calls[0][0];
    expect(sent.map((c) => c.metadata.source)).toEqual(['Word list', 'Word list']);
  });

  it('pages through a long review', async () => {
    const { view } = await open();
    mounted = view;
    const lines = Array.from({ length: 120 }, (_, i) => `w${i}\tg${i}`);
    await paste(view, ['form\tgloss', ...lines].join('\n'));
    await view.step(() => button('Next: review').click());
    expect(document.body.textContent).toContain('Rows 1–50 of 120');
    await view.step(() =>
      all(document.body, 'button')
        .find((b) => b.textContent.includes('Next') && !b.textContent.includes(':'))
        .click(),
    );
    expect(document.body.textContent).toContain('Rows 51–100 of 120');
    expect(document.body.textContent).toContain('Page 2 of 3');
  });

  it('keeps everything after a failed import and goes back to the review', async () => {
    const bulkCreate = vi.fn(async () => {
      throw new Error('The server went away.');
    });
    const { view } = await open({ bulkCreate });
    mounted = view;
    await paste(view, 'form\tgloss\nperro\tdog');
    await view.step(() => button('Next: review').click());
    await view.step(async () => {
      button('Add 1').click();
      await settle();
    });
    expect(document.body.textContent).toContain('The server went away.');
    await view.step(() => button('Back to review').click());
    expect(button('Add 1')).toBeTruthy();
  });

  const startBox = () => document.querySelector('input[type="number"]');
  const typeStart = async (view, value) => {
    await view.step(() => setValue(startBox(), value));
    await view.step(() => startBox().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  };
  const columnTargets = () => all(document.body, 'tbody select').map((s) => s.value);
  const escapeOn = (el) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

  it('keeps the wizard open on Escape in a text field, and puts the start row back', async () => {
    const onOpenChange = vi.fn();
    const { view } = await open({ onOpenChange });
    mounted = view;
    await paste(view, 'title\nform\tgloss\nperro\tdog\nchat\tcat');
    expect(startBox().value).toBe('2');
    startBox().focus();
    await view.step(() => setValue(startBox(), '3'));
    await view.step(() => escapeOn(startBox()));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(startBox().value).toBe('2');
    expect(document.body.textContent).toContain('1 row above it is left out');

    const add = all(document.body, 'select').find((s) => s.textContent.includes('Add a field…'));
    await view.step(() => setValue(add, 'source'));
    const constant = document.querySelector('input[aria-label="Source on every row"]');
    constant.focus();
    await view.step(() => escapeOn(constant));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(constant);

    // Anywhere else Escape closes the dialog, as before.
    await view.step(() => escapeOn(button('Back')));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('numbers the start row as the spreadsheet does, blank lines included', async () => {
    const { view } = await open();
    mounted = view;
    await paste(view, 'Kalamang wordlist\n\n\nForm\tGloss\n\nka\tI\nnu\tmother\nta\twater');
    expect(startBox().value).toBe('4');
    await typeStart(view, '1');
    expect(startBox().value).toBe('1');
    // A blank line starts the table at the next row with something in it.
    await typeStart(view, '3');
    expect(startBox().value).toBe('4');
    expect(columnTargets()).toEqual(['__form__', 'gloss']);
    await view.step(() => button('Next: review').click());
    const lines = all(document.body, 'span.w-8.tabular-nums').map((s) => s.textContent.trim());
    expect(lines).toEqual(['6', '7', '8']);
  });

  it('says when the start row is past the last row and keeps the old one', async () => {
    const { view } = await open();
    mounted = view;
    await paste(view, 'Form\tGloss\nka\tI\n\nnu\tmother');
    await typeStart(view, '99');
    expect(document.body.textContent).toContain('The last row is row 4.');
    expect(startBox().value).toBe('1');
    await typeStart(view, '2e1');
    expect(startBox().value).toBe('1');
  });

  it('reads a start row the user picks as the header, and the checkbox reads the columns again', async () => {
    const { view } = await open({
      fields: [...FIELDS, { name: 'pos', type: 'text' }],
    });
    mounted = view;
    await paste(view, 'Lamkang word list 2024\nLamkang\tEnglish\tPart of speech\nka\tI\tpron');
    expect(startBox().value).toBe('1');
    await typeStart(view, '2');
    expect(columnTargets()).toEqual(['__ignore__', 'gloss', 'pos']);
    expect(document.body.textContent).toContain('Part of speech');

    const box = () => document.querySelector('input[type="checkbox"]');
    await view.step(() => box().click());
    expect(box().checked).toBe(false);
    expect(columnTargets()).toEqual(['__form__', 'gloss', 'source']);
    await view.step(() => box().click());
    expect(box().checked).toBe(true);
    expect(columnTargets()).toEqual(['__ignore__', 'gloss', 'pos']);
  });

  it('leaves out a line of machine keys under the header', async () => {
    const { view } = await open();
    mounted = view;
    await paste(view, 'Lexeme\tEnglish Gloss\nlexeme\ten_gloss\nkaa\thouse');
    expect(document.body.textContent).toContain('The row under the header is left out');
    await view.step(() => button('Next: review').click());
    expect(button('Add 1')).toBeTruthy();
  });

  it('asks for CSV or TSV when a spreadsheet file is dropped', async () => {
    const { notifyError } = await import('@/utils/feedback');
    const { view } = await open();
    mounted = view;
    // The innermost element saying so is the drop zone itself.
    const zone = all(document.body, 'div')
      .filter((d) => d.textContent.startsWith('Drop a .tsv or .csv file here'))
      .at(-1);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: [new File(['PK'], 'words.xlsx')] };
    await view.step(() => zone.dispatchEvent(drop));
    expect(notifyError).toHaveBeenCalledWith(
      'words.xlsx is a spreadsheet file. Save it as CSV or TSV and import it again.',
      'Failed to read the file',
    );
  });
});
