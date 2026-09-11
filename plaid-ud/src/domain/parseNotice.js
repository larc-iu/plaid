// What to say about a finished parse, from what the service actually reported.
//
// The rule (C8): never claim more than we know. A service reports a
// per-sentence failure in its counts, not by failing the request, so a run
// where every sentence was skipped still comes back `status: success` with
// zeros. Announcing "Parsed!" over an untouched document is the bug this
// exists to prevent.
//
// A service that declares its own `notice` authors both the words and the
// severity, and we only map the severity to a colour. The counts are the
// fallback for a service predating that contract.
//
// Pure, so `test/parseNotice.test.js` can drive every shape.
export const parseNotice = (summary) => {
  const notice = summary?.notice;
  if (notice) {
    return {
      level: notice.level === 'success' ? 'success' : 'warning',
      title: notice.title || undefined,
      message: notice.message || undefined,
    };
  }
  const parsed = Number(summary?.parsedSentences) || 0;
  if (parsed > 0) {
    return {
      level: 'success',
      title: undefined,
      message: `Parsed ${parsed} sentence${parsed === 1 ? '' : 's'}.`,
    };
  }
  return {
    level: 'warning',
    title: 'Nothing to parse',
    message: 'The parser reported no changes to this document.',
  };
};
