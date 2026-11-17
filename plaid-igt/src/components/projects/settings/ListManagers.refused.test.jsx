import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { OrthographiesManager } from './OrthographiesManager.jsx';
import { DocumentMetadataManager } from './DocumentMetadataManager.jsx';
import { notifyError, notifyInfo, notifySuccess } from '@/utils/feedback';

// H15-2: a refused save of the orthographies or the document metadata fields
// shows only its failure. The add keeps the typed name, and neither the add
// nor the remove says it happened.

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

const refused = () => vi.fn(async () => Promise.reject(new Error('Changed elsewhere')));

const button = (container, text) =>
  all(container, 'button').find(
    (b) => b.textContent.includes(text) || b.getAttribute('aria-label') === text,
  );

const managers = [
  {
    name: 'OrthographiesManager',
    render: (onSaveChanges) => (
      <OrthographiesManager
        initialData={{
          orthographies: [
            { name: 'Baseline', isBaseline: true },
            { name: 'IPA', isBaseline: false },
          ],
        }}
        onSaveChanges={onSaveChanges}
      />
    ),
    input: (c) => c.querySelector('input'),
    add: 'Add orthography',
    remove: 'Remove IPA',
  },
  {
    name: 'DocumentMetadataManager',
    render: (onSaveChanges) => (
      <MemoryRouter>
        <DocumentMetadataManager
          initialData={{ enabledFields: [{ name: 'Region', enabled: true, isCustom: true }] }}
          onSaveChanges={onSaveChanges}
        />
      </MemoryRouter>
    ),
    input: (c) => c.querySelector('input[placeholder="Enter custom field name"]'),
    add: 'Add field',
    remove: 'Remove Region',
  },
];

describe.each(managers)('$name with a refused save', (m) => {
  beforeEach(() => {
    notifyError.mockClear();
    notifyInfo.mockClear();
    notifySuccess.mockClear();
  });

  it('an add shows only the failure and keeps the typed name', async () => {
    const onSaveChanges = refused();
    const { container, step, unmount } = await renderComponent(m.render(onSaveChanges));
    await step(async () => typeInto(m.input(container), 'Devanagari'));
    await step(async () => button(container, m.add).click());
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifySuccess).not.toHaveBeenCalled();
    expect(m.input(container).value).toBe('Devanagari');
    await unmount();
  });

  it('a remove shows only the failure', async () => {
    const onSaveChanges = refused();
    const { container, step, unmount } = await renderComponent(m.render(onSaveChanges));
    await step(async () => button(container, m.remove).click());
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyInfo).not.toHaveBeenCalled();
    await unmount();
  });

  it('a saved add says so and empties the box', async () => {
    const onSaveChanges = vi.fn(async () => {});
    const { container, step, unmount } = await renderComponent(m.render(onSaveChanges));
    await step(async () => typeInto(m.input(container), 'Devanagari'));
    await step(async () => button(container, m.add).click());
    expect(notifySuccess).toHaveBeenCalledTimes(1);
    expect(m.input(container).value).toBe('');
    await unmount();
  });
});
