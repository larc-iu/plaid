import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@/test/renderComponent.jsx';
import { MetadataField, metadataIsValid } from './MetadataField.jsx';

// The document-side metadata control picks its widget from what the tagset
// allows, which is the branch worth pinning: a fixed list gets a Select, and
// anything that accepts free text has to stay typable.

const field = { name: 'Genre' };
const closed = {
  delimiters: '',
  mode: 'closed',
  values: [{ value: 'Narrative' }, { value: 'Song' }],
};

const render = (props) =>
  renderComponent(<MetadataField field={field} value="" onChange={vi.fn()} {...props} />);

describe('choosing the control', () => {
  it('gives a closed whole-value tagset a real picker', async () => {
    const { container, unmount } = await render({ tagset: closed });
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    expect(container.querySelector('input[list]')).toBeNull();
    await unmount();
  });

  it('keeps a text input when the tagset only suggests', async () => {
    // The whole point of suggesting is that typing still works.
    const { container, unmount } = await render({ tagset: { ...closed, mode: 'suggest' } });
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.querySelector('datalist')).not.toBeNull();
    await unmount();
  });

  it('keeps a text input for MIXED, where lexical values must stay reachable', async () => {
    // A Select here would make `dog` unenterable even though the grid accepts
    // it and isValueAllowed says yes.
    const { container, unmount } = await render({ tagset: { ...closed, mode: 'mixed' } });
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
    await unmount();
  });

  it('keeps a text input when the value is composite, since it has to be typable', async () => {
    const { container, unmount } = await render({ tagset: { ...closed, delimiters: '.' } });
    expect(container.querySelector('input')).not.toBeNull();
    await unmount();
  });

  it('is a plain input with no list when the field has no tagset', async () => {
    const { container, unmount } = await render({ tagset: null });
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.querySelector('datalist')).toBeNull();
    await unmount();
  });
});

describe('a stored value the tagset no longer allows', () => {
  it('stays selectable, so saving does not silently erase it', async () => {
    // Otherwise the control reads as "Not set" and the next save overwrites a
    // real value with nothing.
    const { container, unmount } = await render({ tagset: closed, value: 'Retired' });
    const options = all(container, '[role="option"]').map((n) => n.textContent);
    // Radix renders options into a portal only when open, so fall back to the
    // trigger, which shows what is actually selected.
    const shown = options.length ? options.join(' ') : container.textContent;
    expect(shown).toContain('Retired');
    await unmount();
  });

  it('is flagged on a free-text field rather than hidden', async () => {
    const { container, unmount } = await render({
      tagset: { ...closed, delimiters: '.' },
      value: 'Retired',
    });
    expect(container.textContent).toContain('not in this field');
    await unmount();
  });
});

describe('the order of the list', () => {
  it('is alphabetical in the datalist, whatever order the values were added in', async () => {
    const open = {
      delimiters: '',
      mode: 'suggest',
      values: [{ value: 'Song' }, { value: 'Narrative' }],
    };
    const { container, unmount } = await render({ tagset: open });
    expect(all(container, 'datalist option').map((o) => o.value)).toEqual(['Narrative', 'Song']);
    await unmount();
  });
});

describe('metadataIsValid', () => {
  const fields = [{ name: 'Genre', tagset: 'G' }, { name: 'Note' }];
  const tagsetFor = (f) => (f.tagset ? closed : null);

  it('passes when every governed field holds something allowed', () => {
    expect(metadataIsValid(fields, { Genre: 'Song', Note: 'anything' }, tagsetFor)).toBe(true);
  });

  it('ignores a bad value the user did not touch, so one import cannot lock a document', () => {
    // The grid refuses only what changed; the form has to match, or an
    // off-tagset value left by an import would block even a rename.
    const stored = { Genre: 'Retired' };
    expect(metadataIsValid(fields, { Genre: 'Retired' }, tagsetFor, stored)).toBe(true);
    // ...but changing it to something else bad is still refused.
    expect(metadataIsValid(fields, { Genre: 'AlsoBad' }, tagsetFor, stored)).toBe(false);
    // ...and fixing it is allowed.
    expect(metadataIsValid(fields, { Genre: 'Song' }, tagsetFor, stored)).toBe(true);
  });

  it('fails on a governed field holding something refused', () => {
    expect(metadataIsValid(fields, { Genre: 'Retired' }, tagsetFor)).toBe(false);
  });

  it('treats an empty value as fine: not filling a field in is not an error', () => {
    expect(metadataIsValid(fields, {}, tagsetFor)).toBe(true);
  });

  it('ignores a suggesting tagset, which refuses nothing', () => {
    expect(
      metadataIsValid(fields, { Genre: 'Retired' }, () => ({ ...closed, mode: 'suggest' })),
    ).toBe(true);
  });
});
