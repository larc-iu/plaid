import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import {
  argRowProblems,
  argsToWrite,
  nextArgKey,
  readArgs,
  readRoleset,
  rolesetProblem,
  writeUmr,
} from '@/domain/vocabUmr';

// The rows as the band edits them, from the entry's fields. Each keeps the
// argument it was read as (`base`), which the entry holds while the row's
// name has a problem.
let rowIds = 0;
const seedDraft = (fields) => ({
  roleset: readRoleset(fields),
  rows: readArgs(fields).map((a) => ({ id: (rowIds += 1), ...a, base: a })),
});

// The entry's UMR roleset, shown only where a project that links this
// vocabulary is set up for UMR (see domain/vocabUmr.js for why it is edited
// in this app at all).
//
// An entry with no roleset stands for its own headword, which is the
// guidelines' stage 0 ("use the lemma as is"), so the field being empty is
// the ordinary case and not an omission. The arguments are the roleset's own,
// written the way a frame file writes them.
//
// The boxes show the band's own draft, as typed. What reaches the entry's
// fields is that draft trimmed, with a row whose name has a problem left as
// it was: read back from the fields on every keystroke, a space typed at the
// end of a description was trimmed away before the next letter, and a name
// retyped through `ARG` took its row with it.
export const RolesetBand = ({ uid, fields, setFields, disabled = false }) => {
  const bandId = useId();
  const [draft, setDraft] = useState(() => seedDraft(fields));
  // The fields this band last wrote or was seeded from. A `umr` object other
  // than theirs came from outside (Cancel, another entry, a save read back),
  // and the draft starts again from it. With no `umr` object on either side a
  // change to the fields cannot say which it was, so it starts again too.
  const [own, setOwn] = useState(fields);
  let current = draft;
  if (fields !== own) {
    if (fields?.umr !== own?.umr || !fields?.umr) {
      current = seedDraft(fields);
      setDraft(current);
    }
    setOwn(fields);
  }
  const { roleset, rows } = current;
  const refused = rolesetProblem(roleset);
  const problems = argRowProblems(rows);

  const write = (patch) => {
    const next = { ...current, ...patch };
    const out = writeUmr(fields, { roleset: next.roleset, args: argsToWrite(next.rows) });
    setDraft(next);
    setOwn(out);
    setFields(out);
  };
  const setRow = (i, patch) =>
    write({ rows: rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">UMR</p>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${uid}-roleset`} className="text-xs font-medium text-muted-foreground">
            Roleset
          </Label>
          <Input
            id={`${uid}-roleset`}
            className="h-8"
            value={roleset}
            disabled={disabled}
            placeholder="Roleset"
            aria-invalid={refused ? true : undefined}
            onChange={(e) => write({ roleset: e.target.value })}
          />
          {refused ? (
            <p className="text-xs text-destructive">{refused}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              The concept this entry stands for on a UMR graph. Empty means its headword.
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Arguments</p>
        {rows.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
        {rows.map((row, i) => {
          const problem = problems[i];
          const problemId = `${bandId}-arg-${row.id}-problem`;
          return (
            <div key={row.id} className="flex flex-col gap-1">
              <div className="flex items-start gap-2">
                <div className="flex w-28 shrink-0 flex-col gap-1">
                  <Input
                    aria-label={`Argument ${i + 1} name`}
                    className="h-8"
                    value={row.key}
                    disabled={disabled}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? problemId : undefined}
                    onChange={(e) => setRow(i, { key: e.target.value })}
                  />
                </div>
                <Input
                  aria-label={`Argument ${i + 1} description`}
                  className="h-8 min-w-0 flex-1"
                  value={row.description}
                  disabled={disabled}
                  placeholder="Description"
                  onChange={(e) => setRow(i, { description: e.target.value })}
                />
                {!disabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove argument ${i + 1}`}
                    className="h-8 text-muted-foreground hover:text-destructive"
                    onClick={() => write({ rows: rows.filter((_, k) => k !== i) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {problem && (
                <p id={problemId} className="text-xs text-destructive">
                  {problem}
                </p>
              )}
            </div>
          );
        })}
        {!disabled && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() =>
                write({
                  rows: [
                    ...rows,
                    { id: (rowIds += 1), key: nextArgKey(rows), description: '', base: null },
                  ],
                })
              }
            >
              <Plus className="h-4 w-4" /> Add argument
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
