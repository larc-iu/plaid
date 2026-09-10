import { useState } from 'react';
import { X } from 'lucide-react';
import { Input } from '@ui/components/ui/input';

// An editable list of short strings: the current values as removable chips, and
// one input that appends on Enter. Replaces Mantine's TagsInput, which has no
// shadcn counterpart.
//
// Deliberately not a combobox. These lists are read as a whole (the 17 UPOS
// tags, a feature's values), a duplicate is silently ignored rather than
// rejected with a message, and Backspace on an empty box removes the last chip
// the way every tag field does.
export const TagList = ({ value, onChange, placeholder = 'Add and press Enter', label }) => {
  const [draft, setDraft] = useState('');
  const tags = value || [];

  const add = () => {
    const next = draft.trim();
    if (!next) return;
    if (!tags.includes(next)) onChange([...tags, next]);
    setDraft('');
  };

  const remove = (tag) => onChange(tags.filter((t) => t !== tag));

  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs"
            >
              {tag}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${tag}`}
                onClick={() => remove(tag)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={add}
      />
    </div>
  );
};
