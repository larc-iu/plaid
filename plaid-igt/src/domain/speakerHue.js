// One colour per speaker, the same on every segment, every channel lane and
// in every document of the project: the speaker's place in the (sorted)
// speaker list, stepped round the colour wheel by the golden angle, so the
// first few speakers are always far apart. A hash of the name put "Speaker 1"
// and "Speaker 2" one degree apart.
export const speakerHue = (speaker, speakers) => {
  const i = Math.max(0, (speakers || []).indexOf(speaker));
  return Math.round((30 + i * 137.508) % 360);
};
