// What to say about a finished draft run: the service's own words.
//
// The rule: never claim more than we know. A drafting service reports a
// per-sentence failure in its counts rather than by failing the request, so a
// run where every sentence was skipped or refused still comes back
// `status: success` with zeros. Announcing "Drafted" over an untouched
// document is the bug this exists to prevent.
//
// A service declares its own `notice` (both bundled ones do: see
// `build_draft_notice` in services/umr_draft_llm.py, which the skeleton
// service shares), authoring both the words and the severity. This maps the
// severity to a colour and passes the words through. It used to rebuild the
// sentences from the counts as well, which was a second home for the same
// wording and had already drifted from the service's: the same all-skipped
// run read "Document not modified" from Python and "Nothing drafted" here.
//
// Pure, so `test/draftNotice.test.js` can drive every shape.
export const draftNotice = (summary) => {
  const notice = summary?.notice;
  if (notice) {
    return {
      level: notice.level === 'success' ? 'success' : 'warning',
      title: notice.title || undefined,
      message: notice.message || undefined,
    };
  }
  // A service that reports no notice at all: say that, and nothing about
  // what it may or may not have written.
  return {
    level: 'warning',
    title: 'Draft finished',
    message: 'The service reported no summary.',
  };
};
