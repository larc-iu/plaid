// What to say about a finished comparison, from what the service reported.
// The same rule as draftNotice: never claim more than we know. A service
// that declares its own `notice` authors the words and the severity.
//
// Pure, so `test/compareNotice.test.js` can drive every shape.
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : null);

export const compareNotice = (summary) => {
  const notice = summary?.notice;
  if (notice) {
    return {
      level: notice.level === 'success' ? 'success' : 'warning',
      title: notice.title || undefined,
      message: notice.message || undefined,
    };
  }
  const scores = summary?.scores || {};
  const against = summary?.against?.name;
  const parts = [];
  const sentence = pct(scores.sentence);
  const comprehensive = pct(scores.comprehensive);
  if (sentence) parts.push(`Sentence graphs ${sentence}`);
  if (comprehensive) parts.push(`comprehensive ${comprehensive}`);
  if (!parts.length) {
    return {
      level: 'warning',
      title: 'No scores',
      message: 'The service reported no scores.',
    };
  }
  return {
    level: 'success',
    title: against ? `Compared with ${against}` : 'Compared',
    message: `${parts.join(', ')}.`,
  };
};
