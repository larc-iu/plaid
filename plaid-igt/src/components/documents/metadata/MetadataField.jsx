import { useId } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { MODES, isValueAllowed, tagsetEnforces, validateValue } from '@/domain/tagsets';

// One document-metadata input, governed by its field's tagset if it has one.
//
// Three controls rather than one, because the right affordance depends on what
// the tagset allows. A closed whole-value tagset IS a fixed list, so it gets a
// real Select. Anything that accepts free text keeps a text input, with the
// legal values offered through a native <datalist> — no popup to build, and
// typing still works, which is the whole point of a suggesting tagset.
//
// The interlinear editor solves this differently (a lit-html popup with part-
// aware completion) because a gloss cell is one of hundreds in a keyboard-driven
// grid. A metadata field is one of five on a form, so native controls are the
// right amount of machinery.

// Radix Select has no empty-string item value, so "not set" needs a sentinel.
// A NUL keeps it out of the space of values anyone can actually store, which a
// plain "__unset__" did not.
const UNSET = '\u0000unset';

export const MetadataField = ({ field, value, tagset, onChange }) => {
  const uid = useId();
  const v = value ?? '';
  const violations = tagset ? validateValue(v, tagset) : [];
  const invalid = violations.length > 0;

  // Only `closed` is genuinely a fixed list. `mixed` accepts any lowercase
  // lexical value on top of the list, so a Select there would make values the
  // grid happily accepts unreachable here. With delimiters the value is
  // composite and has to stay typable either way.
  if (tagset?.mode === MODES.CLOSED && !tagset.delimiters) {
    const known = tagset.values.some((t) => t.value === v);
    return (
      <Select
        value={v === '' ? UNSET : v}
        onValueChange={(next) => onChange(next === UNSET ? '' : next)}
      >
        <SelectTrigger
          className={cn(
            invalid && 'underline decoration-destructive decoration-wavy underline-offset-2',
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Not set</SelectItem>
          {tagset.values.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.value}
              {t.description ? (
                <span className="ml-2 text-xs text-muted-foreground">{t.description}</span>
              ) : null}
            </SelectItem>
          ))}
          {/* A value already in the data that the tagset no longer allows. Kept
              selectable so the control shows what is actually stored rather
              than silently reading as "Not set" and overwriting it on save. */}
          {v !== '' && !known && <SelectItem value={v}>{v} (not in tagset)</SelectItem>}
        </SelectContent>
      </Select>
    );
  }

  // Derived from the name, ids collided for fields differing only in non-word
  // characters ("A B" and "A-B" both became md-A-B), pointing one field's input
  // at the other's list.
  const listId = tagset ? uid : undefined;
  return (
    <>
      <Input
        value={v}
        list={listId}
        // A governed field can carry our squiggle, so the browser's must not
        // appear beside it meaning something else.
        spellCheck={tagset ? false : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter ${field.name}`}
        // The same squiggle the grid uses, so an off-tagset value reads the
        // same way wherever it is shown.
        className={cn(
          invalid && 'underline decoration-destructive decoration-wavy underline-offset-2',
        )}
        aria-invalid={invalid || undefined}
      />
      {tagset && (
        <datalist id={listId}>
          {tagset.values.map((t) => (
            <option key={t.value} value={t.value}>
              {t.description ?? ''}
            </option>
          ))}
        </datalist>
      )}
      {invalid && (
        <p className="text-xs text-destructive">
          {violations.some((x) => x.reason === 'unknown')
            ? `${violations
                .filter((x) => x.reason === 'unknown')
                .map((x) => `"${x.part}"`)
                .join(', ')} is not in this field's tagset.`
            : 'There is a delimiter with nothing beside it.'}
        </p>
      )}
    </>
  );
};

/**
 * May this edit be saved? Only fields the user actually CHANGED are judged.
 *
 * The grid refuses a value on the way in and leaves what is already stored
 * alone (`next !== orig` in IgtEditor._commitField). The form has to match, or
 * one off-tagset value an import left behind would lock the whole document out
 * of saving — you could not even rename it — and the deliberately preserved
 * "(not in tagset)" option would be visible but unsavable.
 */
export const metadataIsValid = (fields, values, tagsetFor, original = {}) =>
  fields.every((f) => {
    const next = values[f.name] ?? '';
    if (next === (original[f.name] ?? '')) return true;
    const t = tagsetFor(f);
    return !tagsetEnforces(t) || isValueAllowed(next, t);
  });
