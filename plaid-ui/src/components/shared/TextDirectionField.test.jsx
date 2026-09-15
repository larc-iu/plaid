import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { TextDirectionField } from './TextDirectionField.jsx';
import { DocumentModel } from '../../domain/DocumentModel.js';

// The escape hatch, and the one line of it that has to be true: the trigger
// says what automatic came out AS, because the only reason to open this
// control is that the guess was wrong.

class Doc extends DocumentModel {
  constructor(raw, body) {
    super({
      raw,
      client: { withOperation: (_, fn) => fn(), documents: { patchMetadata: vi.fn() } },
    });
    this._body = body;
  }
  get body() {
    return this._body;
  }
}

const ARABIC = 'قرأ الولد الكتاب';

const mount = (doc, props) => renderComponent(<TextDirectionField doc={doc} {...props} />);

describe('TextDirectionField', () => {
  it('shows what automatic came out as', async () => {
    const { container, unmount } = await mount(new Doc({ id: 'd1', metadata: {} }, ARABIC));
    expect(all(container, '[id="text-direction"]')[0].textContent).toContain('right to left');
    await unmount();
  });

  it('says left to right for a Latin document', async () => {
    const { container, unmount } = await mount(new Doc({ id: 'd1', metadata: {} }, 'the cat sat'));
    expect(all(container, '[id="text-direction"]')[0].textContent).toContain('left to right');
    await unmount();
  });

  it('shows the override rather than the guess once one is set', async () => {
    const doc = new Doc({ id: 'd1', metadata: { plaid: { textDirection: 'rtl' } } }, 'the cat sat');
    const { container, unmount } = await mount(doc);
    expect(all(container, '[id="text-direction"]')[0].textContent).toBe('Right to left');
    await unmount();
  });

  it('is disabled for a reader', async () => {
    const doc = new Doc({ id: 'd1', metadata: {} }, ARABIC);
    const { container, unmount } = await mount(doc, { disabled: true });
    expect(all(container, 'button')[0].hasAttribute('disabled')).toBe(true);
    await unmount();
  });
});

describe('setting it', () => {
  const docWith = (metadata) => {
    const patchMetadata = vi.fn(() => Promise.resolve());
    const doc = new Doc({ id: 'd1', metadata }, 'the cat sat');
    doc._client = { withOperation: (_, fn) => fn(), documents: { patchMetadata } };
    return { doc, patchMetadata };
  };

  it('writes the whole reserved namespace, not just the key', async () => {
    // A document metadata PATCH replaces a nested namespace wholesale, so
    // anything else another app keeps in there has to be restated.
    const { doc, patchMetadata } = docWith({ plaid: { role: 'baseline' }, Speaker: 'Amina' });
    await doc.setTextDirection('rtl');
    expect(patchMetadata).toHaveBeenCalledWith('d1', {
      plaid: { role: 'baseline', textDirection: 'rtl' },
    });
  });

  it('clears the key when put back to automatic', async () => {
    const { doc, patchMetadata } = docWith({ plaid: { textDirection: 'rtl' } });
    await doc.setTextDirection('auto');
    expect(patchMetadata).toHaveBeenCalledWith('d1', { plaid: {} });
    expect(doc.textDirection).toBe('ltr');
  });

  it('writes nothing when the value has not changed', async () => {
    const { doc, patchMetadata } = docWith({ plaid: { textDirection: 'rtl' } });
    expect(await doc.setTextDirection('rtl')).toBe(false);
    expect(patchMetadata).not.toHaveBeenCalled();
  });

  it('takes effect without a reload', async () => {
    const { doc } = docWith({});
    expect(doc.textDirection).toBe('ltr');
    await doc.setTextDirection('rtl');
    expect(doc.textDirection).toBe('rtl');
  });
});
