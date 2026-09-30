// The cell engine's view (CellEngine.js) of a grid whose cells are inputs the
// app draws by hand or with a template library, not React: what the engine
// may ask of a drawn cell and do to it. The engine's state is drawn by the
// app's own template (the value at rest from `display`, the classes and note
// from `unsentOf` and `conflictOf`). This only touches the input itself.
//
// `dataset.orig` is the value an edit of the cell is measured against, the
// one Escape puts back. The app's template never binds it.
//
// Focus: a value refused and put back goes into its cell with focus only
// when focus is in that cell or nowhere (on the body). Never from another
// cell: the person may be typing there when the refusal lands, and taking
// focus back would send those letters after the refused value. A conflict
// takes focus on the same terms.
//
// - `find(key, canonical)`: the drawn input for a cell key, or null.
// - `putBackOf(key)`: the value a refusal last put back into the cell.
// - `shown(el, value)`: the app's own upkeep after its value was set by hand
//   (classes a template would draw for that value).

const free = (el) => {
  const active = document.activeElement;
  return !active || active === document.body || active === el;
};

export const domCells =
  ({ find, putBackOf = () => null, shown = () => {} }) =>
  (key, canonical) => {
    const el = find(key, canonical);
    if (!el) return null;
    return {
      focused: () => document.activeElement === el,
      typedSince: (typed) =>
        document.activeElement === el &&
        el.value !== typed &&
        el.value !== (el.dataset.orig ?? '') &&
        el.value !== putBackOf(key),
      takeUp: ({ typed, saved }) => {
        if (!free(el)) return false;
        // Focus first: the app's focus handler sets the baseline from what
        // the cell shows, and the value typed over is the baseline here.
        el.focus();
        el.value = typed;
        el.dataset.orig = saved;
        shown(el, typed);
        return true;
      },
      showStored: (value, { conflict = false, typed = null } = {}) => {
        // Typed into since `typed` (the value that lost) was shown: that is
        // newer, and leaving the cell sends it.
        const focused = document.activeElement === el;
        if (conflict && focused && typed != null) {
          if (el.value !== typed && el.value !== (el.dataset.orig ?? '')) return;
        }
        el.value = value;
        if (conflict || document.activeElement === el) el.dataset.orig = value;
        shown(el, value);
        if (conflict && free(el)) el.focus();
      },
      update: () => {},
    };
  };
