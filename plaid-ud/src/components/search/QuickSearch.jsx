import { useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { QUICK_FIELDS, MATCH_TYPES, quickPattern } from '../../grew/quickSearch.js';

// A plain word lookup for people who do not write Grew.
//
// It does not run a search of its own: it writes the Grew pattern and hands it
// to the box below, which runs it. So a quick search is the first draft of a
// real one — change the field, see the pattern, edit it — and there is one
// compiler, one set of warnings, one residue of unsupported things.
export const QuickSearch = ({ onSearch, disabled }) => {
  const [field, setField] = useState('lemma');
  const [match, setMatch] = useState('contains');
  const [text, setText] = useState('');

  const submit = () => {
    const pattern = quickPattern(field, match, text);
    if (pattern) onSearch(pattern);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Select value={field} onValueChange={setField} disabled={disabled}>
        <SelectTrigger className="h-8 w-44" aria-label="Which field">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {QUICK_FIELDS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={match} onValueChange={setMatch} disabled={disabled}>
        <SelectTrigger className="h-8 w-28" aria-label="How to match">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MATCH_TYPES.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        className="h-8 w-56"
        placeholder="What to look for"
        aria-label="What to look for"
        spellCheck={false}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button size="sm" disabled={disabled || !text.trim()} onClick={submit}>
        Search
      </Button>
    </div>
  );
};
