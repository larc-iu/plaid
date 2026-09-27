import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import { notifyError } from '@/utils/feedback';

// A document metadata field may not take a key Plaid keeps for itself: the
// shared plaid settings, or a provenance key.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  humanizeError: (e) => String(e),
}));

const typeInto = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const addField = async (name) => {
  const onSaveChanges = vi.fn();
  const { container, step, unmount } = await renderComponent(
    <MemoryRouter>
      <DocumentMetadataManager
        initialData={{ enabledFields: [{ name: 'Date', enabled: true, isCustom: false }] }}
        onSaveChanges={onSaveChanges}
      />
    </MemoryRouter>,
  );
  const input = container.querySelector('input[placeholder="Enter custom field name"]');
  await step(async () => typeInto(input, name));
  const add = all(container, 'button').find((b) => b.textContent.includes('Add field'));
  await step(async () => add.click());
  await unmount();
  return onSaveChanges;
};

describe('DocumentMetadataManager reserved names', () => {
  beforeEach(() => notifyError.mockClear());

  it('refuses plaid', async () => {
    const onSaveChanges = await addField('plaid');
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'plaid is reserved for document settings',
      'Invalid field name',
    );
  });

  it('refuses a provenance key', async () => {
    const onSaveChanges = await addField('provSource');
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'provSource is reserved for provenance',
      'Invalid field name',
    );
  });

  it('takes any other name', async () => {
    const onSaveChanges = await addField('Speaker');
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    expect(notifyError).not.toHaveBeenCalled();
  });
});
