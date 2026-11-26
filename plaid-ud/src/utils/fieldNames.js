// A token field as the screen names it, in a cell's title and in the toast
// when a write to it is refused ("Failed to update XPOS", as igt says
// "Failed to update Gloss").
//
// Each name is a message: `fieldName` gives the English (the audit log's
// operation is named with it), and the place that shows it calls t().
import { msg } from '../../../plaid-ui/src/lib/i18n.js';

const FIELD_NAMES = {
  form: msg('Form'),
  lemma: msg('Lemma'),
  upos: 'UPOS', // i18n-ignore: a CoNLL-U column name
  xpos: 'XPOS', // i18n-ignore: a CoNLL-U column name
  features: msg('Features'),
};

export const fieldName = (field) => FIELD_NAMES[field] ?? field;
