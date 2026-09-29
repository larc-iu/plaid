// Research telemetry (core manual, "Research telemetry"): what a person does
// with a guess. A guess drawn in a cell is `suggestion.shown`, one taken as it
// is (Enter on the cell, Ctrl+Enter on its word) is `suggestion.adopted`, and a
// different value written where it showed is `suggestion.dismissed`.
//
// The client's recorder does the rest: it sends nothing while the project's
// switch is off, records a shown guess once per target, field and value in a
// page session however often the grid re-renders, and never throws. Nothing
// here records keys, clicks or focus.
export const telemetry = {
  _recordSuggestion(type, { targetId, field, value, source, written }) {
    const doc = this.doc;
    const events = doc?.client?.events;
    if (!events?.record || !doc.projectId || doc.asOf || !targetId) return;
    const data = { value, source, field };
    if (written !== undefined) data.written = written;
    events.record(type, { projectId: doc.projectId, documentId: doc.id, targetId, data });
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
  _guessAnswered(el, next) {
    const value = el.dataset.guessValue;
    if (!value || next === '' || (el.dataset.orig ?? '') !== '') return;
    const guess = {
      targetId: el.dataset.guessTarget,
      field: el.dataset.guessField,
      value,
      source: el.dataset.guessSource,
    };
    if (next === value) this._recordSuggestion('suggestion.adopted', guess);
    else this._recordSuggestion('suggestion.dismissed', { ...guess, written: next });
  },
};
