// Sticky speaker for fast diarization: a new segment defaults to the speaker of
// the previously saved one, so labeling a run of same-speaker turns is one
// keystroke (just save). Session-scoped; the persisted truth is the token
// metadata plus the project speaker cache. Shared by the timeline popover and
// the transcript list so the default follows the user between the two.
let lastSpeaker = '';

export const getStickySpeaker = () => lastSpeaker;

export const setStickySpeaker = (speaker) => {
  lastSpeaker = (speaker || '').trim();
};
