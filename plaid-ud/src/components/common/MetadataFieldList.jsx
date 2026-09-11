import { useState } from 'react';
import { X } from 'lucide-react';
import { Input } from '@ui/components/ui/input';

// The project's metadata fields for one level, as removable chips plus an input
// that appends on Enter.
//
// TagList's shape, but not TagList: a metadata field can be REFUSED (a dot
// breaks it for the query engine, a reserved name would collide with what the
// exporter writes), and TagList ignores a bad value silently because its lists
// are tag sets where a duplicate is just a duplicate. Saying why is the whole
// difference, so this keeps the refusal on screen until the name changes.
export const MetadataFieldList = ({ value, onChange, validate, placeholder, label }) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const fields = value || [];

  const add = () => {
    const next = draft.trim();
    if (!next) return;
    const why = validate(next, fields);
    if (why) {
      setError(why);
      return;
    }
    onChange([...fields, next]);
    setDraft('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {fields.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {fields.map((field) => (
            <span
              key={field}
              className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs"
            >
              {field}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${field}`}
                onClick={() => onChange(fields.filter((f) => f !== field))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          add();
        }}
        onBlur={add}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
};
