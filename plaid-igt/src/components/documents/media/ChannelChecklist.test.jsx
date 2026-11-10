import { describe, it, expect, afterEach } from 'vitest';
import { useEffect } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ChannelChecklist } from './ChannelChecklist.jsx';
import { useChosenChannels } from './useChosenChannels.js';

// The channel boxes a run dialog shows for a recording with a speaker on each
// channel: all on to begin with, each one off by its box, and nothing at all
// for a recording whose channels are not speakers.

let view;
let api;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const Probe = ({ speakers }) => {
  const channels = useChosenChannels(speakers);
  useEffect(() => {
    api = channels;
  });
  return <ChannelChecklist channels={channels} />;
};

describe('ChannelChecklist', () => {
  it('lists each channel by its speaker or number, all on, and says what is chosen', async () => {
    view = await renderComponent(<Probe speakers={['Ana', '']} />);
    const boxes = [...view.container.querySelectorAll('input[type=checkbox]')];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.checked)).toBe(true);
    expect(view.container.textContent).toContain('Ana');
    expect(view.container.textContent).toContain('Channel 2');
    expect(api.chosen).toEqual([
      { channel: 0, speaker: 'Ana' },
      { channel: 1, speaker: '' },
    ]);
    expect(api.none).toBe(false);
  });

  it('a box off leaves its channel out, and none left is said', async () => {
    view = await renderComponent(<Probe speakers={['Ana', 'Ben']} />);
    const [first, second] = view.container.querySelectorAll('input[type=checkbox]');
    await view.step(() => first.click());
    expect(api.chosen).toEqual([{ channel: 1, speaker: 'Ben' }]);
    await view.step(() => second.click());
    expect(api.chosen).toEqual([]);
    expect(api.none).toBe(true);
  });

  it('renders nothing when the channels are not speakers', async () => {
    view = await renderComponent(<Probe speakers={null} />);
    expect(view.container.querySelector('[data-channel-checklist]')).toBeNull();
    expect(api.chosen).toBeNull();
    expect(api.none).toBe(false);
  });
});
