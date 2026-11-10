import { useEffect, useMemo, useState } from 'react';
import { channelLabel } from '@/domain/media/channelSpeakers';

// Which channels of a recording with a speaker on each a run is for: all of
// them to begin with, each one off by its box (ChannelChecklist.jsx). Shared
// by the detection and transcription dialogs.

/**
 * @param {string[]|null} stored  the recording's channelSpeakers, or null
 * @param {number|null} count  the recording's channel count, null until read
 * @returns {{list: Array<{channel, speaker, label}>, on: Set<number>,
 *   toggle: (channel) => void, chosen: Array<{channel, speaker}>|null,
 *   none: boolean, waiting: boolean}} `chosen` is null when the channels are
 *   not speakers (run the whole recording), `none` when every box is off.
 *   `waiting` while there is a list and the count is not read yet: the list
 *   may be another recording's (useMediaOperations reads it as absent once
 *   the count says so), so no channel is listed and a run waits.
 */
export function useChosenChannels(stored, count) {
  const waiting = !!stored && count == null;
  const speakers = waiting ? null : stored;
  const list = useMemo(
    () =>
      speakers
        ? speakers.map((speaker, channel) => ({
            channel,
            speaker: speaker || '',
            label: channelLabel(channel, speakers),
          }))
        : [],
    [speakers],
  );
  const [off, setOff] = useState(() => new Set());
  // Another recording, or another list: every box on again.
  useEffect(() => setOff(new Set()), [speakers]);
  const on = useMemo(
    () => new Set(list.filter((c) => !off.has(c.channel)).map((c) => c.channel)),
    [list, off],
  );
  const toggle = (channel) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  const chosen = speakers
    ? list.filter((c) => on.has(c.channel)).map(({ channel, speaker }) => ({ channel, speaker }))
    : null;
  return { list, on, toggle, chosen, none: !!speakers && on.size === 0, waiting };
}
