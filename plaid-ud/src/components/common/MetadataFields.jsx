import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';

// One metadata field: its name and its value, committed on blur or Enter. Each
// field is its own write, so a slow save on one never holds another up and
// there is no Save button to forget.
const Field = ({ name, declared, value, readOnly, onCommit, onRemove }) => {
  const [draft, setDraft] = useState(value ?? '');

  // Follow the stored value when it changes underneath (another tab, a reload,
  // a service run). Keyed on the value alone, so typing here is never stomped
  // by an unrelated emit, the same rule the annotation cells follow.
  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  // Escape blurs the input, and that blur fires synchronously inside the key
  // handler with the typed text still in `draft`, so without this the cancel
  // saved exactly what it was cancelling. The annotation cells carry the same
  // ref for the same reason.
  const cancelledRef = useRef(false);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(value ?? '');
      return;
    }
    if (draft === (value ?? '')) return;
    onCommit(name, draft.trim());
  };

  // A field nobody declared still holds a value and still exports, so it is
  // shown and can be removed. Saying why keeps it from reading as a bug — as a
  // tooltip on the name rather than a line of its own, because a CoNLL-U import
  // brings in a dozen of these at a time and a dozen copies of one sentence is
  // noise, not an explanation.
  const hint = declared ? undefined : `${name} is not one of this project's fields.`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label
        htmlFor={`metadata-${name}`}
        className={declared ? undefined : 'text-amber-700'}
        title={hint}
      >
        {name}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={`metadata-${name}`}
          value={draft}
          spellCheck={false}
          disabled={readOnly}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Cancel THIS edit, and let a second Escape close the dialog
              // these fields may be inside. Radix listens on the document, so
              // leaving the event to bubble would take both in one keystroke.
              e.stopPropagation();
              cancelledRef.current = true;
              setDraft(value ?? '');
              e.currentTarget.blur();
            }
          }}
        />
        {onRemove && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${name}`}
            title={
              declared
                ? `Clear ${name}. It stays here because this project declares it.`
                : `Remove ${name}`
            }
            onClick={() => {
              cancelledRef.current = false;
              setDraft('');
              onRemove(name);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
};

// Name a field that nobody declared and nothing has stored yet. CoNLL-U's
// `# k = v` comments are open-ended, so writing one the project never heard of
// is ordinary work rather than an escape hatch. The name is committed on Enter
// or on leaving the box, and Escape drops it; there is no Add button, for the
// same reason the value fields have no Save button.
const AddField = ({ taken, validateName, onAdd }) => {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const close = () => {
    setAdding(false);
    setName('');
    setError(null);
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return close();
    const why = validateName ? validateName(trimmed, taken) : null;
    if (why) {
      setError(why);
      return;
    }
    onAdd(trimmed);
    close();
  };

  if (!adding) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="gap-1 self-start"
        onClick={() => setAdding(true)}
      >
        <Plus className="h-4 w-4" />
        Add field
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        autoFocus
        value={name}
        spellCheck={false}
        placeholder="field name"
        aria-label="New field name"
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            // Drop the name being typed without also closing the dialog; see
            // the value field's Escape.
            e.preventDefault();
            e.stopPropagation();
            setName('');
            e.currentTarget.blur();
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
};

// The rows of a metadata editor for one level. `rows` comes from
// utils/udMetadata.js `metadataRows`, which decides what belongs here.
//
// `validateName` turns this into an editor for ALL of a level's metadata
// rather than only the fields the project declares: pass one and a reader can
// name a new field. It returns why a name cannot be used, or null.
export const MetadataFields = ({ rows, values, readOnly, onCommit, validateName }) => {
  // Fields named but not yet written. A field only exists once it holds a
  // value (an empty one is a deletion), so the name has to be held here until
  // the first commit puts it among `rows` for good.
  const [pending, setPending] = useState([]);
  useEffect(() => {
    setPending((prev) => prev.filter((name) => !rows.some((row) => row.name === name)));
  }, [rows]);

  const shown = useMemo(
    () => [
      ...rows,
      ...pending
        .filter((name) => !rows.some((row) => row.name === name))
        .map((name) => ({ name, declared: false })),
    ],
    [rows, pending],
  );

  // Removing a field is writing it empty, which is what the server reads as a
  // deletion. A field the project DECLARES comes straight back as an empty box,
  // because the project still offers it; one nobody declared is gone.
  const remove = (name) => {
    setPending((prev) => prev.filter((n) => n !== name));
    onCommit(name, '');
  };

  return (
    <div className="flex flex-col gap-3">
      {shown.map((row) => (
        <Field
          key={row.name}
          name={row.name}
          declared={row.declared}
          value={values?.[row.name]}
          readOnly={readOnly}
          onCommit={onCommit}
          onRemove={remove}
        />
      ))}
      {!readOnly && validateName && (
        <AddField
          taken={shown.map((row) => row.name)}
          validateName={validateName}
          onAdd={(name) => setPending((prev) => [...prev, name])}
        />
      )}
    </div>
  );
};
