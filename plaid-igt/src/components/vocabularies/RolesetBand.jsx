import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import { argKeyProblem, nextArgKey, readArgs, readRoleset, writeUmr } from '@/domain/vocabUmr';

// The entry's UMR roleset, shown only where a project that links this
// vocabulary is set up for UMR (see domain/vocabUmr.js for why it is edited
// in this app at all).
//
// An entry with no roleset stands for its own headword, which is the
// guidelines' stage 0 ("use the lemma as is"), so the field being empty is
// the ordinary case and not an omission. The arguments are the roleset's own,
// written the way a frame file writes them.
export const RolesetBand = ({ uid, fields, setFields, disabled = false }) => {
  const bandId = useId();
  const roleset = readRoleset(fields);
  const args = readArgs(fields);

  const write = (next) => setFields(writeUmr(fields, { roleset, args, ...next }));
  const setArg = (i, patch) =>
    write({ args: args.map((a, k) => (k === i ? { ...a, ...patch } : a)) });

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
            placeholder="leave-02"
            onChange={(e) => write({ roleset: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The concept this entry stands for on a UMR graph. Empty means its headword.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Arguments</p>
        {args.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
        {args.map((arg, i) => {
          const problem = argKeyProblem(arg.key);
          return (
            <div key={`${bandId}-arg-${i}`} className="flex items-start gap-2">
              <div className="flex w-28 shrink-0 flex-col gap-1">
                <Input
                  aria-label={`Argument ${i + 1} name`}
                  className="h-8"
                  value={arg.key}
                  disabled={disabled}
                  onChange={(e) => setArg(i, { key: e.target.value })}
                />
              </div>
              <Input
                aria-label={`Argument ${i + 1} description`}
                className="h-8 min-w-0 flex-1"
                value={arg.description}
                disabled={disabled}
                placeholder="the one who leaves"
                onChange={(e) => setArg(i, { description: e.target.value })}
              />
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove argument ${i + 1}`}
                  className="h-8 text-muted-foreground hover:text-destructive"
                  onClick={() => write({ args: args.filter((_, k) => k !== i) })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
              {problem && <p className="sr-only">{problem}</p>}
            </div>
          );
        })}
        {args.some((a) => argKeyProblem(a.key)) && (
          <p className="text-xs text-destructive">
            {argKeyProblem(args.find((a) => argKeyProblem(a.key)).key)}
          </p>
        )}
        {!disabled && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => write({ args: [...args, { key: nextArgKey(args), description: '' }] })}
            >
              <Plus className="h-4 w-4" /> Add argument
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
