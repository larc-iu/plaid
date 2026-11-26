// A write's label is said twice. When the write fails, the screen shows it
// as the title of the error, in the reader's language. The audit log names
// the operation after it ("Failed to create relation" is "Create relation"),
// in English, since everyone who reads the project's history shares it.
//
// So a label is the English message: a plain string, marked msg() where it
// is written, or `writeLabel(msg(message), values, shownValues)` for one with
// values in it. ConlluDocument's `_queueWrite` and `_canWrite` take either,
// and hand the translation to the screen and the English to the audit log.
//
// As igt's src/domain/writeLabel.js, with one difference: a value that is
// itself a word of the interface (a field's name, "Lemma") is English in the
// audit log and translated on screen, so it may be given twice.
//
// By its real path: the `node --test` suite has no `@ui` alias.
import { t } from '../../../plaid-ui/src/lib/i18n.js';

/**
 * A label with values, `{field}` each:
 * `writeLabel('Failed to update {field}', { field: 'Lemma' }, { field: t('Lemma') })`.
 * `shownValues` are the values as the screen shows them, `values` when absent.
 */
export const writeLabel = (message, values, shownValues = values) => ({
  message,
  values,
  shownValues,
});

/** The label as the screen shows it. */
export const shownLabel = (label) =>
  typeof label === 'string' ? t(label) : t(label.message, label.shownValues);

/** The label in English, its values filled in. */
const englishLabel = (label) =>
  typeof label === 'string'
    ? label
    : label.message.replace(/\{(\w+)\}/g, (_, name) => String(label.values?.[name] ?? ''));

// As DocumentModel names an operation after its error label: "Failed to
// create relation" is "Create relation".
export const operationOf = (label) => {
  const s = englishLabel(label).replace(/^Failed to\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
