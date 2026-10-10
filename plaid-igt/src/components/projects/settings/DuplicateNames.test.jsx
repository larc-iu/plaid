import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager.jsx';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import { notifyError } from '@/utils/feedback';

// A name typed in one Unicode spelling is the same name as one stored in the
// other: "Café" with a composed é and with an e and a combining accent.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const DECOMPOSED = 'Cafe\u0301';
const COMPOSED = 'caf\u00e9';

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const tryToAdd = async (element, placeholder) => {
  const { container, step, unmount } = await renderComponent(
    <MemoryRouter>{element}</MemoryRouter>,
  );
  const input = container.querySelector(`input[placeholder="${placeholder}"]`);
  await step(async () => typeInto(input, COMPOSED));
  const add = all(container, 'button').find((b) => b.textContent.includes('Add field'));
  const disabled = add.disabled;
  await step(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await unmount();
  return disabled;
};

describe('a decomposed name is a duplicate of its composed twin', () => {
  beforeEach(() => notifyError.mockClear());

  it('in annotation field names', async () => {
    const onSaveChanges = vi.fn();
    const disabled = await tryToAdd(
      <FieldsManager
        initialData={{
          fields: [{ name: DECOMPOSED, scope: 'Word', isCustom: true }],
          ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [] },
        }}
        onSaveChanges={onSaveChanges}
      />,
      'Enter field name',
    );
    expect(disabled).toBe(true);
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'A Word field with this name already exists',
      'Duplicate field',
    );
  });

  it('in document metadata names', async () => {
    const onSaveChanges = vi.fn();
    const disabled = await tryToAdd(
      <DocumentMetadataManager
        initialData={{ enabledFields: [{ name: DECOMPOSED, enabled: true, isCustom: true }] }}
        onSaveChanges={onSaveChanges}
      />,
      'Enter custom field name',
    );
    expect(disabled).toBe(true);
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'A field with this name already exists',
      'Duplicate field',
    );
  });
});
