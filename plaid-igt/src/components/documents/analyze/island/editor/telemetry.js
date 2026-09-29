// Research telemetry (core manual, "Research telemetry"): what a person does
// with a guess. A guess drawn in a cell is `suggestion.shown`, one taken as it
// is (Enter on the cell, Ctrl+Enter on its word) is `suggestion.adopted`, and a
// different value written where it showed is `suggestion.dismissed`.
//
// An answer is recorded once its write has landed. The value is on screen at
// once like every edit, but a save the server refuses put nothing in the
// record, so it records nothing, and the retry that lands records the answer
// then, once.
//
// The client's recorder does the rest: it sends nothing while the project's
// switch is off, records a shown guess once per target, field and value in a
// page session however often the grid re-renders, and never throws. Nothing
// here records keys, clicks or focus.
export const telemetry = {
  // The event for `type` about `guess`, or null when this grid records none.
  // Built when the person answers, so it names the document and the view they
  // answered in, whatever the grid shows by the time the save lands.
  _suggestionEvent(type, { targetId, field, value, source, written }) {
    const doc = this.doc;
    if (!doc?.client?.events?.record || !doc.projectId || doc.asOf || !targetId) return null;
    const data = { value, source, field };
    if (written !== undefined) data.written = written;
    return { type, projectId: doc.projectId, documentId: doc.id, targetId, data };
  },

  _recordEvent(event) {
    if (!event) return;
    const { type, ...rest } = event;
    this.doc?.client?.events?.record?.(type, rest);
  },

  _recordSuggestion(type, guess) {
    this._recordEvent(this._suggestionEvent(type, guess));
  },

  // Record `events` once `saved`, a write's promise, lands. Resolves to what
  // `saved` resolves to, so the caller still sees a refusal. A write that is
  // refused (false) or throws records nothing.
  _recordWhenSaved(saved, events) {
    return Promise.resolve(saved).then((ok) => {
      if (ok !== false) for (const e of events) this._recordEvent(e);
      return ok;
    });
  },

  // A cell drew guess `g` for `targetId`'s `field`. Called on every render.
  _guessShown(g, targetId, field) {
    this._recordSuggestion('suggestion.shown', {
      targetId,
      field,
      value: g.value,
      source: g.source,
    });
  },

  // A cell that showed a guess is being written with `next`: the guess itself
  // is adopted, anything else dismisses it. A cell left empty says nothing.
  // Answers the event to record once the write lands, or null.
  _guessAnswer(el, next) {
    const value = el.dataset.guessValue;
    if (!value || next === '' || (el.dataset.orig ?? '') !== '') return null;
    const guess = {
      targetId: el.dataset.guessTarget,
      field: el.dataset.guessField,
      value,
      source: el.dataset.guessSource,
    };
    if (next === value) return this._suggestionEvent('suggestion.adopted', guess);
    return this._suggestionEvent('suggestion.dismissed', { ...guess, written: next });
  },
};
