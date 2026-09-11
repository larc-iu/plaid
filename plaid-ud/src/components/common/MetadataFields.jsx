import { useEffect, useRef, useState } from 'react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';

// One project-declared metadata field: its name and its value, committed on
// blur or Enter. Each field is its own write, so a slow save on one never holds
// another up and there is no Save button to forget.
const Field = ({ name, declared, value, readOnly, dense, onCommit }) => {
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
  // shown and can be cleared. Saying why keeps it from reading as a bug.
  const hint = declared
    ? undefined
    : `${name} is not one of this project's fields. Clear it to remove it.`;

  const input = (
    <Input
      id={dense ? undefined : `metadata-${name}`}
      value={draft}
      spellCheck={false}
      disabled={readOnly}
      className={dense ? 'h-6 px-1.5 py-0 text-xs' : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          cancelledRef.current = true;
          setDraft(value ?? '');
          e.currentTarget.blur();
        }
      }}
      aria-label={dense ? name : undefined}
    />
  );

  if (dense) {
    return (
      <div className="flex items-center gap-1.5" title={hint}>
        <span
          className={`shrink-0 text-[10px] font-medium ${declared ? 'text-muted-foreground' : 'text-amber-700'}`}
        >
          {name}
        </span>
        <div className="w-44">{input}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`metadata-${name}`} className={declared ? undefined : 'text-amber-700'}>
        {name}
      </Label>
      {input}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
};

// The rows of a metadata editor for one level. `rows` comes from
// utils/udMetadata.js `metadataRows`, which decides what belongs here.
export const MetadataFields = ({ rows, values, readOnly, dense = false, onCommit }) => (
  <div className={dense ? 'flex flex-wrap items-center gap-x-4 gap-y-1' : 'flex flex-col gap-4'}>
    {rows.map((row) => (
      <Field
        key={row.name}
        name={row.name}
        declared={row.declared}
        value={values?.[row.name]}
        readOnly={readOnly}
        dense={dense}
        onCommit={onCommit}
      />
    ))}
  </div>
);
