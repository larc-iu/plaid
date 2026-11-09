import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ChannelList } from './ChannelList.jsx';

// The channel list: one row per channel with its speaker, Mute and Solo. The
// speaker is written when the box is left or Enter is pressed, Esc puts it
// back, and the two toggles say their state.

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const button = (label) =>
  all(view.container, 'button').find((b) => b.getAttribute('aria-label') === label);
const field = (label) => view.container.querySelector(`[aria-label="${label}"]`);
const type = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await view.step(() => el.dispatchEvent(new Event('input', { bubbles: true })));
};
const key = (el, k) =>
  view.step(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

const mount = async (props = {}) => {
  view = await renderComponent(
    <ChannelList
      count={2}
      speakers={['Ana', '']}
      knownSpeakers={['Ana', 'Ben']}
      muted={new Set()}
      solo={new Set()}
      onToggleMute={vi.fn()}
      onToggleSolo={vi.fn()}
      onSpeakerChange={vi.fn()}
      onRemove={vi.fn()}
      {...props}
    />,
  );
};

describe('ChannelList', () => {
  it('shows a row per channel, named by its speaker or its number', async () => {
    await mount();
    expect(view.container.querySelectorAll('[data-channel]')).toHaveLength(2);
    expect(field('Ana speaker').value).toBe('Ana');
    expect(field('Channel 2 speaker').value).toBe('');
    expect(button('Mute Ana')).toBeTruthy();
    expect(button('Solo Channel 2')).toBeTruthy();
    expect(view.container.querySelectorAll('datalist option')).toHaveLength(2);
  });

  it('shows nothing for a recording with one channel', async () => {
    await mount({ count: 1 });
    expect(view.container.querySelector('[data-channel-list]')).toBeNull();
  });

  it('Mute and Solo say their state and ask for the toggle', async () => {
    const onToggleMute = vi.fn();
    const onToggleSolo = vi.fn();
    await mount({ muted: new Set([1]), solo: new Set([0]), onToggleMute, onToggleSolo });
    expect(button('Mute Channel 2').getAttribute('aria-pressed')).toBe('true');
    expect(button('Mute Ana').getAttribute('aria-pressed')).toBe('false');
    expect(button('Solo Ana').getAttribute('aria-pressed')).toBe('true');
    await view.step(() => button('Mute Ana').click());
    await view.step(() => button('Solo Channel 2').click());
    expect(onToggleMute).toHaveBeenCalledWith(0);
    expect(onToggleSolo).toHaveBeenCalledWith(1);
  });

  it('a speaker typed into a channel is written on Enter, trimmed, and only when it changed', async () => {
    const onSpeakerChange = vi.fn();
    await mount({ onSpeakerChange });
    const box = field('Channel 2 speaker');
    await type(box, ' Ben ');
    await key(box, 'Enter');
    expect(onSpeakerChange).toHaveBeenCalledWith(1, ' Ben ');
    onSpeakerChange.mockClear();
    await view.step(() => field('Ana speaker').dispatchEvent(new Event('blur', { bubbles: true })));
    expect(onSpeakerChange).not.toHaveBeenCalled();
  });

  it('Esc puts the box back to what is stored', async () => {
    const onSpeakerChange = vi.fn();
    await mount({ onSpeakerChange });
    const box = field('Ana speaker');
    await type(box, 'Anabel');
    await key(box, 'Escape');
    expect(box.value).toBe('Ana');
    await view.step(() => box.dispatchEvent(new Event('blur', { bubbles: true })));
    expect(onSpeakerChange).not.toHaveBeenCalled();
  });

  it('is read-only for a reader: no boxes to type in', async () => {
    await mount({ readOnly: true });
    expect(field('Ana speaker').disabled).toBe(true);
    expect(view.container.querySelector('datalist')).toBeNull();
  });

  it('Remove speakers per channel asks for the way back, and a reader has none', async () => {
    const onRemove = vi.fn();
    await mount({ onRemove });
    const remove = () =>
      all(view.container, 'button').find((b) => b.textContent === 'Remove speakers per channel');
    await view.step(() => remove().click());
    expect(onRemove).toHaveBeenCalledTimes(1);
    await view.unmount();
    view = null;
    await mount({ onRemove, readOnly: true });
    expect(remove()).toBeUndefined();
  });
});
