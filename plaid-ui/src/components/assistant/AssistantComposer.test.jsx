import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef, useState } from 'react';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { AssistantComposer } from './AssistantComposer.jsx';

// The composer mounted, because what it has to get right is the keyboard. The
// `@` list takes Enter before the Enter that sends, Escape closes the list and
// leaves the typed text alone, and Shift+Enter is the newline the placeholder
// promises rather than a send. The hook under it is covered on its own
// (useMentions.test.jsx) and takes every key as an argument, so only a mount
// can show that the composer hands them over in that order.

const SERVICE = { serviceId: 'a', serviceName: 'Assistant one' };
const SECOND = { serviceId: 'b', serviceName: 'Assistant two' };

const choiceOf = (over = {}) => ({
  service: SERVICE,
  assistants: [SERVICE],
  stranded: [],
  choose: vi.fn(),
  canChoose: false,
  wentOffline: false,
  ...over,
});

const fakeClient = (documents = []) => ({
  projects: { listDocumentsPage: vi.fn().mockResolvedValue({ entries: documents }) },
});

const SENTENCES = () => [
  {
    group: 'Sentences',
    items: [
      { value: 's1', label: 's1', hint: 'Todos los seres humanos' },
      { value: 's2', label: 's2', hint: 'nacen libres' },
    ],
  },
];

const mount = async ({
  client = fakeClient(),
  choice = choiceOf(),
  onSend = vi.fn(),
  offer,
  ...rest
} = {}) => {
  const Host = () => {
    const [text, setText] = useState('');
    const inputRef = useRef(null);
    return (
      <AssistantComposer
        client={client}
        projectId="p1"
        choice={choice}
        text={text}
        setText={setText}
        inputRef={inputRef}
        canSend
        onSend={onSend}
        mentionOffer={offer}
        {...rest}
      />
    );
  };
  const view = await renderComponent(<Host />);
  const box = view.container.querySelector('textarea');
  // Type `value` with the caret at its end, the way a keyboard leaves it.
  const type = (value) =>
    view.step(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(box, value);
      box.selectionStart = value.length;
      box.selectionEnd = value.length;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const press = (key, init = {}) =>
    view.step(async () => {
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );
      // The pick that Enter makes puts the caret back after a paint.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const rows = () => all(view.container, '[data-active]').map((n) => n.textContent);
  return { ...view, box, onSend, client, choice, type, press, rows };
};

beforeEach(() => vi.clearAllMocks());

describe('AssistantComposer', () => {
  it('sends on Enter', async () => {
    const m = await mount();
    await m.type('gloss it');
    await m.press('Enter');
    expect(m.onSend).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it('leaves Shift+Enter to the newline the placeholder promises', async () => {
    const m = await mount();
    await m.type('first line');
    await m.press('Enter', { shiftKey: true });
    expect(m.onSend).not.toHaveBeenCalled();
    expect(m.box.value).toBe('first line');
    await m.unmount();
  });

  it('takes Enter for the `@` list instead of sending', async () => {
    // The one real risk in the gesture: this composer sends on Enter, so the
    // list has to be asked first.
    const m = await mount({ offer: SENTENCES });
    await m.type('about @libres');
    expect(m.rows()).toEqual(['s2nacen libres']);
    await m.press('Enter');
    expect(m.onSend).not.toHaveBeenCalled();
    expect(m.box.value).toBe('about s2 ');
    expect(m.rows()).toEqual([]);
    await m.unmount();
  });

  it('closes the list on Escape and keeps what was typed', async () => {
    const m = await mount({ offer: SENTENCES });
    await m.type('about @s');
    expect(m.rows()).toHaveLength(2);
    await m.press('Escape');
    expect(m.rows()).toEqual([]);
    expect(m.box.value).toBe('about @s');
    expect(m.onSend).not.toHaveBeenCalled();
    await m.unmount();
  });

  it('names the assistant that replaces one gone offline, and offers the choice', async () => {
    const m = await mount({
      choice: choiceOf({ wentOffline: true, canChoose: true, assistants: [SERVICE, SECOND] }),
    });
    expect(m.container.textContent).toContain(
      'The assistant this conversation started with is offline',
    );
    expect(m.container.textContent).toContain('Assistant one');
    expect(m.container.querySelector('[aria-label="Assistant"]')).not.toBeNull();
    await m.unmount();
  });

  it('offers no substitute picker where there is nothing to choose between', async () => {
    const m = await mount({ choice: choiceOf({ wentOffline: true }) });
    expect(m.container.textContent).toContain(
      'The assistant this conversation started with is offline',
    );
    expect(m.container.querySelector('[aria-label="Assistant"]')).toBeNull();
    await m.unmount();
  });
});
