// A token field as the screen names it, in a cell's title and in the toast
// when a write to it is refused ("Failed to update XPOS", as igt says
// "Failed to update Gloss").
const FIELD_NAMES = {
  form: 'Form',
  lemma: 'Lemma',
  upos: 'UPOS',
  xpos: 'XPOS',
  features: 'Features',
};

export const fieldName = (field) => FIELD_NAMES[field] ?? field;
