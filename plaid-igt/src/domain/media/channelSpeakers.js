// The speaker on each channel of a multichannel recording, kept on the
// document as `channelSpeakers`: one entry per channel in channel order,
// written by this app when several files are mixed into one recording and
// when a person fills in the channel list on the Media tab. An entry may be
// empty, for a channel with no speaker. A recording uploaded plainly has no
// list, and nothing is read into its channels: two channels are two speakers
// only when the list says so.

export const CHANNEL_SPEAKERS_KEY = 'channelSpeakers';

/**
 * The list as stored, each entry a trimmed string, or null when the document
 * has none. Anything in an entry that is not a string reads as no speaker.
 */
export function readChannelSpeakers(metadata) {
  const raw = metadata?.[CHANNEL_SPEAKERS_KEY];
  if (!Array.isArray(raw)) return null;
  return raw.map((s) => (typeof s === 'string' ? s.trim() : ''));
}

/**
 * The list as the recording's own: null when the recording's channel count
 * is known and is not the list's length, since the list then names the
 * channels of another recording. While the count is not known, the list.
 */
export const speakersForChannels = (speakers, count) =>
  speakers && count != null && speakers.length !== count ? null : speakers;

/**
 * The list with channel `index` set to `speaker`, sized to `count` channels
 * (a shorter stored list is padded with empty entries, a longer one kept).
 */
export function withChannelSpeaker(speakers, index, speaker, count) {
  const size = Math.max(count || 0, (speakers || []).length, index + 1);
  const next = Array.from({ length: size }, (_, i) => speakers?.[i] ?? '');
  next[index] = (speaker || '').trim();
  return next;
}

/** What a channel is called on screen: its speaker, else its number. */
export const channelLabel = (index, speakers) => speakers?.[index] || `Channel ${index + 1}`;
