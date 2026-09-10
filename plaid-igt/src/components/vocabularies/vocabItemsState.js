import { ANY_FIELD } from '@/domain/vocabItemFilter';
import { editableMetadata } from '@/domain/vocabFields';

// The state of the Entries screen that is not data and not the URL: the edit
// draft, the list's scope, and which dialog is open. One reducer, so what
// each transition does to the rest is written here once rather than repaired
// by an effect after the fact. Everything in here is pure.
//
// The selection itself lives in the URL (`?item=`, `?parent=`) and the data
// (the entries, usage counts) in the component; the draft follows the URL
// through `draft/seed`, keyed by what it was last filled from, so a re-fetch
// of the same entry leaves the typing alone.

export const NEW_ID = '__new__';

// What the draft is filled from: an entry's id, or for a new entry the parent
// it is a sense of. A new entry and a new sense of some entry share one id in
// the URL, so the parent is part of the key: going from one to the other
// must not leave the typing behind on a form that now means something else.
export const seedKeyFor = (selectedId, newParent) =>
  selectedId === NEW_ID ? `${NEW_ID}|${newParent ?? ''}` : selectedId;

// Drop blank/nullish values so we never persist empty-string metadata keys.
export const cleanMeta = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v != null && String(v).trim() !== '') out[k] = v;
  }
  return out;
};

export const metaEqual = (a, b) => {
  const ca = cleanMeta(a);
  const cb = cleanMeta(b);
  const ka = Object.keys(ca);
  if (ka.length !== Object.keys(cb).length) return false;
  return ka.every((k) => String(ca[k]) === String(cb[k]));
};

// Does the draft differ from what it would be saved over? A new entry is
// dirty once anything is typed; an existing one once the form or a field
// differs from the entry as stored.
export const isDirty = (draft, item) => {
  if (!item) return draft.form.trim() !== '' || Object.keys(cleanMeta(draft.fields)).length > 0;
  return (
    draft.form.trim() !== item.form || !metaEqual(draft.fields, editableMetadata(item.metadata))
  );
};

export const initialState = {
  draft: { seedKey: undefined, form: '', fields: {} },
  scope: { search: '', field: ANY_FIELD, emptyOnly: false, offTagsetOnly: false },
  // null | { kind: 'bulk' | 'replace' | 'delete' | 'homograph' }
  //      | { kind: 'discard', target: { id, parent } | { to } }
  dialog: null,
};

// The "N without <field>" filter only means something for a real field:
// the form is never empty, and "all fields" names no column.
export const emptyFieldOf = (field) =>
  field && field !== ANY_FIELD && field !== 'form' ? field : null;

export function reducer(state, action) {
  switch (action.type) {
    // ---- the draft ----
    case 'draft/seed':
      return {
        ...state,
        draft: { seedKey: action.seedKey, form: action.form, fields: action.fields },
      };
    case 'draft/form':
      return { ...state, draft: { ...state.draft, form: action.form } };
    case 'draft/fields':
      return { ...state, draft: { ...state.draft, fields: action.fields } };
    // Back to the entry as stored, keeping the seed: a cancel is not a
    // reason to re-seed on the next render.
    case 'draft/reset':
      return { ...state, draft: { ...state.draft, form: action.form, fields: action.fields } };
    // Forget what the draft was filled from, so the next sync re-seeds it
    // (after a save, an import, a repair that touched the open entry).
    case 'draft/unseed':
      return { ...state, draft: { ...state.draft, seedKey: undefined } };

    // ---- the list's scope ----
    case 'scope/search':
      return { ...state, scope: { ...state.scope, search: action.search } };
    // The empty-only filter belongs to the field it was switched on for.
    case 'scope/field':
      return { ...state, scope: { ...state.scope, field: action.field, emptyOnly: false } };
    case 'scope/toggleEmptyOnly':
      return { ...state, scope: { ...state.scope, emptyOnly: !state.scope.emptyOnly } };
    case 'scope/toggleOffTagsetOnly':
      return {
        ...state,
        scope: { ...state.scope, offTagsetOnly: !state.scope.offTagsetOnly },
      };

    // ---- dialogs: one at a time ----
    case 'dialog/open':
      return { ...state, dialog: { kind: action.kind } };
    case 'dialog/askDiscard':
      return { ...state, dialog: { kind: 'discard', target: action.target } };
    case 'dialog/close':
      return state.dialog ? { ...state, dialog: null } : state;
    default:
      return state;
  }
}
