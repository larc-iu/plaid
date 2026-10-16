import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager.jsx';

// REV-WIRE-4: a save refused because values in use are not in a closed list
// is an answer the screen shows, not a fault, so the console stays quiet.
// Any other failure is still logged.

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

const addField = async (error) => {
  const onSaveChanges = vi.fn(async () => {
    throw error;
  });
  const onError = vi.fn();
  const view = await renderComponent(
    <MemoryRouter>
      <FieldsManager
        initialData={{
          fields: [{ name: 'Gloss', scope: 'Word', isCustom: false }],
          ignoredTokens: { mode: 'unicode-punctuation', unicodePunctuationExceptions: [] },
        }}
        onSaveChanges={onSaveChanges}
        onError={onError}
      />
    </MemoryRouter>,
  );
  const input = view.container.querySelector('input[placeholder="Enter field name"]');
  await view.step(async () => typeInto(input, 'Note'));
  await view.step(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
  await view.unmount();
  return { onSaveChanges, onError };
};

afterEach(() => vi.restoreAllMocks());

describe('a refused fields save', () => {
  it('logs nothing when values in use are not in the list', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = Object.assign(new Error('Values in use are not in the list'), {
      refusedValues: [{ layerId: 'l', field: 'Gloss', count: 1, valueCount: 1, values: [] }],
    });
    const { onSaveChanges, onError } = await addField(refused);
    expect(onSaveChanges).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(refused);
    expect(log.mock.calls.filter((c) => /fields configuration/.test(String(c[0])))).toEqual([]);
  });

  it('logs any other failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await addField(new Error('boom'));
    expect(log.mock.calls.filter((c) => /fields configuration/.test(String(c[0])))).toHaveLength(1);
  });
});
