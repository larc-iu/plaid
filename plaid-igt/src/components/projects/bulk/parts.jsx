import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ArrowRight } from 'lucide-react';
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
import { ListPager } from '@ui/components/shared/list-search';
import { TALL_LIST_PAGE_SIZE, usePagedList } from '@ui/hooks/usePagedList';
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
//
// PAGED, because a sweep over a corpus previews thousands of matches and every
// row carries a change grid, a sentence with its marks and a link into Analyze:
// drawing them all is what made the tab stop answering. A page is a fixed
// number of ROWS, so a document with two matches and one with two thousand cost
// the same to draw, and a document heading appears wherever its rows begin on
// the page. The heading's tick and count still speak for the WHOLE document,
// not for the part of it on screen: selection is what gets applied, and it must
// not depend on where the reader happened to be standing.
export const MatchGroups = ({ projectId, rows, selected, toggle, toggleMany, renderRow, dim }) => {
  const groups = useMemo(() => groupByDoc(rows), [rows]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows.map((r) => ({ g, r }))), [groups]);
  const paged = usePagedList(flat, {
    pageSize: TALL_LIST_PAGE_SIZE,
    // A fresh preview is a different list, so it opens at the first page. Two
    // previews with the same matches in the same order are the same list (a
    // changed replacement over the same hits), and the reader keeps their place.
    resetKey: `${flat.length}|${flat[0]?.r.id ?? ''}|${flat[flat.length - 1]?.r.id ?? ''}`,
  });
  if (!flat.length) return null;
  return (
    <div className="rounded-lg border bg-card">
      <ListPager {...paged} onPage={paged.setPage} position="top" />
      <div className="divide-y">
        {paged.pageItems.map(({ g, r }, i) => {
          // A document heading opens the page it continues onto, so a reader
          // who turns the page mid-document still sees which one they are in.
          const head = i === 0 || paged.pageItems[i - 1].g !== g;
          const ids = head ? g.rows.map((x) => x.id) : null;
          const on = ids ? ids.filter((id) => selected.has(id)).length : 0;
          return (
            <Fragment key={r.id}>
              {head && (
                <div className="flex items-center gap-2 bg-muted/50 px-3 py-2">
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
              )}
              <div className={cn('flex items-start gap-3 px-3 py-2', dim?.(r) && 'opacity-60')}>
                <div className="pt-0.5">
                  <Checkbox checked={selected.has(r.id)} onChange={(v) => toggle(r.id, v)} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{renderRow(r)}</div>
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
            </Fragment>
          );
        })}
      </div>
      <ListPager {...paged} onPage={paged.setPage} />
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
              {summary} It lands as one entry in each document’s History.
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
        dir={matchType === 'regex' ? 'ltr' : 'auto'}
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
        dir={matchType === 'regex' ? 'ltr' : 'auto'}
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
