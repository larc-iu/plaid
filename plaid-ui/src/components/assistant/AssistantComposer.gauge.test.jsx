import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { AssistantComposer } from './AssistantComposer.jsx';
import { UsageMeter } from './UsageMeter.jsx';
import { mentionsClient as fakeClient } from '../../test/fakeClient.js';

// The note over the message box names the limit that is close: the model's
// context or the stored record. A record that cannot take another message
// says so and offers a new conversation, and sends nothing.

const SERVICE = { serviceId: 'a', serviceName: 'Assistant one' };
const choice = {
  service: SERVICE,
  assistants: [SERVICE],
  choose: vi.fn(),
  canChoose: false,
  wentOffline: false,
};

const MB = 1048576;

const mount = async (props) => {
  const onSend = vi.fn();
  const Host = () => {
    const [text, setText] = useState('next message');
    const inputRef = useRef(null);
    return (
      <AssistantComposer
        client={fakeClient()}
        projectId="p1"
        choice={choice}
        text={text}
        setText={setText}
        inputRef={inputRef}
        canSend
        onSend={onSend}
        {...props}
      />
    );
  };
  const view = await renderComponent(<Host />);
  const press = () =>
    view.step(() => {
      view.container
        .querySelector('textarea')
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
    });
  const sendButton = () => view.container.querySelector('button[title="Send"]');
  return { ...view, onSend, press, sendButton, text: () => view.container.textContent };
};

describe('the composer note', () => {
  it('keeps the context wording when the context is the limit that is close', async () => {
    const m = await mount({
      usage: { sent: 90_000, window: 100_000 },
      record: { bytes: 1 * MB, cap: 5 * MB },
    });
    expect(m.text()).toContain('This conversation is 90% full. Start a new one.');
    expect(m.text()).not.toContain('storage');
    await m.unmount();
  });

  it('names storage when the record is the limit that is close, with the context low', async () => {
    const m = await mount({
      usage: { sent: 10_000, window: 100_000 },
      record: { bytes: 4.5 * MB, cap: 5 * MB },
    });
    expect(m.text()).toContain(
      "This conversation's storage is 90% full. Start a new conversation to keep going.",
    );
    // Still sendable: nearly full is not full.
    await m.press();
    expect(m.onSend).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it('says nothing below both thresholds', async () => {
    const m = await mount({
      usage: { sent: 10_000, window: 100_000 },
      record: { bytes: 1 * MB, cap: 5 * MB },
    });
    expect(m.text()).not.toContain('full');
    await m.unmount();
  });

  it('at the cap says the conversation is full, offers a new one and sends nothing', async () => {
    const onStartNew = vi.fn();
    const m = await mount({
      usage: { sent: 10_000, window: 100_000 },
      record: { bytes: 5 * MB - 100, cap: 5 * MB },
      onStartNew,
    });
    expect(m.text()).toContain('This conversation is full.');
    expect(m.text()).not.toContain('storage is');
    expect(m.sendButton().disabled).toBe(true);
    await m.press();
    expect(m.onSend).not.toHaveBeenCalled();
    const start = [...m.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'New conversation',
    );
    await m.step(() => start.click());
    expect(onStartNew).toHaveBeenCalledTimes(1);
    await m.unmount();
  });

  it('at the cap with a plan waiting offers only deciding it', async () => {
    const m = await mount({
      record: { bytes: 5 * MB - 100, cap: 5 * MB },
      pendingPlan: true,
    });
    expect(m.container.querySelector('textarea').placeholder).toBe(
      'Approve or discard the plan above',
    );
    await m.unmount();
  });
});

describe('the meter', () => {
  it('shows the fuller limit, amber, and its tooltip names it and gives both', async () => {
    const view = await renderComponent(
      <UsageMeter
        usage={{ sent: 10_000, window: 100_000 }}
        spend={20_000}
        record={{ bytes: 4.5 * MB, cap: 5 * MB }}
      />,
    );
    const meter = view.container.firstChild;
    expect(meter.textContent).toBe('90%');
    expect(meter.dataset.gauge).toBe('storage');
    expect(meter.querySelector('.bg-warning')).not.toBeNull();
    const title = meter.getAttribute('title');
    expect(title).toContain('The bar shows storage.');
    expect(title).toContain('90% of the available storage (4.5/5 MB)');
    expect(title).toContain('10% of this model');
    await view.unmount();
  });
});
