// What to say about a finished draft run, from what the service actually
// reported.
//
// The rule: never claim more than we know. A service reports a per-sentence
// failure in its counts rather than by failing the request, so a run where
// every sentence was skipped or refused still comes back `status: success`
// with zeros. Announcing "Drafted" over an untouched document is the bug this
// exists to prevent.
//
// A service that declares its own `notice` authors both the words and the
// severity, and this only maps the severity to a colour. The counts are the
// fallback for a service that predates that contract.
//
// Pure, so `test/draftNotice.test.js` can drive every shape.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const draftNotice = (summary) => {
  const notice = summary?.notice;
  if (notice) {
    return {
      level: notice.level === 'success' ? 'success' : 'warning',
      title: notice.title || undefined,
      message: notice.message || undefined,
    };
  }
  const drafted = Number(summary?.drafted) || 0;
  const skipped = Number(summary?.skipped) || 0;
  const failed = Number(summary?.failed) || 0;
  const tail = [];
  if (skipped) tail.push(`Skipped ${plural(skipped, 'sentence')} that already had a graph.`);
  if (failed) tail.push(`Failed ${plural(failed, 'sentence')}.`);
  if (drafted > 0) {
    return {
      level: 'success',
      title: `Drafted ${plural(drafted, 'sentence')}`,
      message: tail.join(' ') || undefined,
    };
  }
  return {
    level: 'warning',
    title: 'Nothing drafted',
    message: tail.join(' ') || 'The service reported no changes to this document.',
  };
};
