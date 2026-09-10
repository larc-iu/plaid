import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ArrowRight, Replace } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@ui/components/ui/alert-dialog';
import { cn } from '@ui/lib/utils';
import { MATCH_TYPES } from '../search/searchQueries.js';
import { MarkedText } from '@/components/shared/MarkedText.jsx';
import { hitTo, rememberCaret } from '../search/hitLinks.js';
import { groupByDoc } from './bulkPlan.js';
import { plural } from './bulkShared.js';

// The chrome every Bulk Edit panel is built from: the tick box, the grouped
// match list, the selection summary, the apply bar, the find/replace fields,
// the progress line, and the before/after grid.
export const Checkbox = ({ checked, onChange, indeterminate = false, ...rest }) => (
  <input
    type="checkbox"
    checked={checked}
    ref={(el) => {
      if (el) el.indeterminate = indeterminate && !checked;
    }}
    onChange={(e) => onChange(e.target.checked)}
    className="h-4 w-4 cursor-pointer accent-primary"
    {...rest}
  />
);

export const Change = ({ from, to }) => (
  <span className="inline-flex items-center gap-1 font-mono text-sm">
    <span className="rounded bg-red-50 px-1 text-red-800 line-through decoration-red-400">
      {from === '' ? '∅' : from}
    </span>
    <ArrowRight className="h-3 w-3 text-muted-foreground" />
    <span className="rounded bg-green-50 px-1 text-green-800">{to === '' ? '∅' : to}</span>
  </span>
);

// The document-grouped match list. `renderRow(row)` fills the cell after the
// checkbox; the sentence context is the same for every operation.
export const MatchGroups = ({ projectId, rows, selected, toggle, toggleMany, renderRow, dim }) => {
  const groups = useMemo(() => groupByDoc(rows), [rows]);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const ids = g.rows.map((r) => r.id);
        const on = ids.filter((id) => selected.has(id)).length;
        return (
          <div key={g.docId} className="rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
              <Checkbox
                checked={on === ids.length && ids.length > 0}
                indeterminate={on > 0 && on < ids.length}
                onChange={(v) => toggleMany(ids, v)}
                aria-label={`Select all in ${g.docName}`}
              />
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{g.docName}</span>
              <span className="text-xs text-muted-foreground">
                {on} of {plural(ids.length, 'match', 'matches')} selected
              </span>
            </div>
            <div className="divide-y">
              {g.rows.map((r) => (
                <div
                  key={r.id}
                  className={cn('flex items-start gap-3 px-3 py-2', dim?.(r) && 'opacity-60')}
                >
                  <div className="pt-0.5">
                    <Checkbox checked={selected.has(r.id)} onChange={(v) => toggle(r.id, v)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {renderRow(r)}
                    </div>
                    {r.sentenceId && (
                      <Link
                        to={hitTo(projectId, r.docId, r.sentenceId)}
                        onClick={() => rememberCaret(r.docId, r.sentenceId, r.hitBegin ?? null)}
                        className="mt-0.5 block text-sm text-muted-foreground hover:text-foreground"
                        title="Open in Analyze"
                      >
                        <span className="mr-2 text-xs">#{r.sentenceIndex + 1}</span>
                        <MarkedText text={r.text} marks={r.marks} />
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const SelectionSummary = ({ rows, selected, setSelected, extra }) => {
  const ids = rows.map((r) => r.id);
  const on = ids.filter((id) => selected.has(id)).length;
  const docs = new Set(rows.map((r) => r.docId).filter(Boolean)).size;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span>
        <strong>{plural(rows.length, 'match', 'matches')}</strong>
        {docs > 0 && <> in {plural(docs, 'document')}</>}, <strong>{on}</strong> selected
        {extra}
      </span>
      <button
        type="button"
        className="text-xs text-primary underline-offset-2 hover:underline"
        onClick={() => setSelected(new Set(ids))}
      >
        select all
      </button>
      <button
        type="button"
        className="text-xs text-primary underline-offset-2 hover:underline"
        onClick={() => setSelected(new Set())}
      >
        select none
      </button>
    </div>
  );
};

// Apply button + the confirm step. `summary` is the sentence in the dialog.
export const ApplyBar = ({ count, busy, summary, onApply, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
      {children}
      <div className="ml-auto flex items-center gap-2">
        <Button onClick={() => setOpen(true)} disabled={busy || count === 0}>
          {busy ? 'Applying…' : `Apply ${plural(count, 'change')}`}
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply {plural(count, 'change')}?</AlertDialogTitle>
            <AlertDialogDescription>
              {summary} The edit lands as one entry in each document’s History, so it can be
              reviewed and reverted from there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                onApply();
              }}
            >
              Apply
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// find / match type / replacement — the shared "describe the substitution"
// row for respell and field.
export const SubstitutionFields = ({
  find,
  setFind,
  matchType,
  setMatchType,
  repl,
  setRepl,
  onEnter,
}) => (
  <div className="flex flex-wrap items-end gap-2">
    <div className="flex min-w-48 flex-1 flex-col gap-1">
      <Label htmlFor="bulk-find">Find</Label>
      <Input
        id="bulk-find"
        compose={matchType !== 'regex'}
        value={find}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        placeholder={matchType === 'regex' ? 'pattern, e.g. ([aeiou])h' : 'text'}
        spellCheck={false}
      />
    </div>
    <div className="flex flex-col gap-1">
      <Label>Match</Label>
      <Select value={matchType} onValueChange={setMatchType}>
        <SelectTrigger className="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MATCH_TYPES.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex min-w-48 flex-1 flex-col gap-1">
      <Label htmlFor="bulk-repl">Replace with</Label>
      <Input
        id="bulk-repl"
        compose={matchType !== 'regex'}
        value={repl}
        onChange={(e) => setRepl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        placeholder={matchType === 'regex' ? 'replacement, $1 for groups' : 'replacement'}
        spellCheck={false}
      />
    </div>
  </div>
);

export const Progress = ({ text }) =>
  text ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
      {text}
    </p>
  ) : null;

// ---- respell -------------------------------------------------------------------

export const ChangeGrid = ({ lines }) => {
  const cell = (v) => <span className="font-mono text-sm">{v === '' ? '∅' : v}</span>;
  return (
    <div className="inline-grid grid-cols-[5.5rem_auto_auto_auto] items-center gap-x-2 gap-y-0.5">
      {lines.map((l) => (
        <Fragment key={l.label}>
          <span className={cn('text-xs', l.cls)}>{l.label}</span>
          {cell(l.from)}
          {l.to != null ? <ArrowRight className="h-3 w-3 text-muted-foreground" /> : <span />}
          {l.to != null ? cell(l.to) : <span />}
        </Fragment>
      ))}
    </div>
  );
};
