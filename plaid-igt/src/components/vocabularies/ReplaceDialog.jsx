// Find and replace across one field of a vocabulary. Every entry is already
// in memory, so the rows update as the person types; ticking rows is the
// review, and the chosen ones are written under one operation.

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { humanizeFieldName } from '@/domain/vocabFields';
import { buildReplacer } from '@/domain/replacer';
import { planVocabReplace, replaceWrites } from '@/domain/vocabReplace';
import { MATCH_TYPES } from '../projects/search/searchQueries.js';

// One write is one batch op, and plaid-core caps a batch at 1000.
const CHUNK = 200;

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;

const Checkbox = ({ checked, onChange, indeterminate = false, ...rest }) => (
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

const Change = ({ from, to }) => (
  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-sm">
    <span className="truncate rounded bg-red-50 px-1 text-red-800 line-through decoration-red-400">
      {from === '' ? '∅' : from}
    </span>
    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
    <span className="truncate rounded bg-green-50 px-1 text-green-800">{to === '' ? '∅' : to}</span>
  </span>
);

export const ReplaceDialog = ({
  open,
  onOpenChange,
  vocabularyName,
  fields,
  tagsetFor,
  items,
  homonyms,
  client,
  onApplied,
}) => {
  // The form, then every text field. Morph types are a fixed set shown by
  // label, edited on the entry form.
  const targets = useMemo(
    () => [
      { name: 'form', label: 'Form' },
      ...fields
        .filter((f) => f.name !== 'morphType')
        .map((f) => ({ name: f.name, label: humanizeFieldName(f.name) })),
    ],
    [fields],
  );
  const [field, setField] = useState('form');
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const target = targets.find((t) => t.name === field) ?? targets[0];
  const tagset = tagsetFor(target.name);
  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );
  const rows = useMemo(
    () =>
      planVocabReplace(items, { field: target.name, apply, tagset }).sort((a, b) =>
        a.form.localeCompare(b.form),
      ),
    [items, target, apply, tagset],
  );
  // A new plan is a new selection: everything writable, nothing flagged.
  useEffect(() => {
    setSelected(new Set(rows.filter((r) => !r.invalid).map((r) => r.id)));
  }, [rows]);

  const writable = rows.filter((r) => !r.invalid);
  const chosen = writable.filter((r) => selected.has(r.id));
  const flagged = rows.filter((r) => r.invalid);
  const outsideTagset = flagged.filter((r) => r.invalid === 'tagset').length;
  const emptied = flagged.filter((r) => r.invalid === 'empty').length;

  const toggle = (id, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  const doApply = async () => {
    const itemsById = new Map(items.map((it) => [it.id, it]));
    const writes = replaceWrites(chosen, { field: target.name, itemsById });
    if (!writes.length) return;
    setBusy(true);
    let done = 0;
    try {
      await client.withOperation(
        `Replace “${find}” → “${repl}” in ${target.label} of ${vocabularyName || 'vocabulary'}`,
        async () => {
          for (let i = 0; i < writes.length; i += CHUNK) {
            const chunk = writes.slice(i, i + CHUNK);
            await client.batched(async () => {
              for (const w of chunk) {
                if (w.form != null) client.vocabItems.update(w.id, w.form);
                else if (Object.keys(w.metadata).length)
                  client.vocabItems.setMetadata(w.id, w.metadata);
                else client.vocabItems.deleteMetadata(w.id);
              }
            });
            done += chunk.length;
            setProgress(`${done.toLocaleString()} of ${writes.length.toLocaleString()}`);
          }
        },
      );
      await onApplied();
      notifySuccess(`${plural(writes.length, 'value')} replaced in ${target.label}.`, 'Replaced');
      setFind('');
      setRepl('');
      onOpenChange(false);
    } catch (err) {
      console.error('Replace failed:', err);
      notifyError(
        humanizeError(
          err,
          `Replaced ${done.toLocaleString()} of ${writes.length.toLocaleString()}.`,
        ),
        'Replace failed',
      );
      await onApplied();
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find and Replace</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label>In</Label>
              <Select value={target.name} onValueChange={setField}>
                <SelectTrigger className="w-40" aria-label="Field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Match</Label>
              <Select value={matchType} onValueChange={setMatchType}>
                <SelectTrigger className="w-40" aria-label="Match">
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
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <Label htmlFor="vocab-replace-find">Find</Label>
              <Input
                id="vocab-replace-find"
                compose={matchType !== 'regex'}
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder={matchType === 'regex' ? 'pattern, e.g. ([aeiou])h' : 'text'}
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <Label htmlFor="vocab-replace-with">Replace with</Label>
              <Input
                id="vocab-replace-with"
                compose={matchType !== 'regex'}
                value={repl}
                onChange={(e) => setRepl(e.target.value)}
                placeholder={matchType === 'regex' ? 'replacement, $1 for groups' : 'replacement'}
                spellCheck={false}
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">Check your regex: {error}</p>}

          {find && !error && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>
                <strong>{plural(rows.length, 'match', 'matches')}</strong>,{' '}
                <strong>{chosen.length}</strong> selected
              </span>
              {writable.length > 0 && (
                <>
                  <button
                    type="button"
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    onClick={() => setSelected(new Set(writable.map((r) => r.id)))}
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
                </>
              )}
            </div>
          )}
          {outsideTagset > 0 && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {plural(outsideTagset, 'value')} would fall outside the{' '}
              <strong>{tagset?.name ?? 'field'}</strong> tagset and cannot be written.
            </p>
          )}
          {emptied > 0 && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {plural(emptied, 'entry', 'entries')} would be left with no form and cannot be
              written.
            </p>
          )}

          {find && !error && rows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching values.</p>
          )}
          {rows.length > 0 && (
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
              <div className="divide-y">
                {rows.map((r) => (
                  <label
                    key={r.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 px-3 py-1.5',
                      r.invalid && 'cursor-default opacity-60',
                    )}
                  >
                    <Checkbox
                      checked={selected.has(r.id)}
                      disabled={!!r.invalid}
                      onChange={(v) => toggle(r.id, v)}
                      aria-label={`Replace in ${r.form}`}
                    />
                    <span className="w-32 shrink-0 truncate text-sm font-medium" title={r.form}>
                      {r.form}
                      {homonyms?.get(r.id) != null && (
                        <sub className="ml-0.5 text-[0.7em] text-muted-foreground">
                          {homonyms.get(r.id)}
                        </sub>
                      )}
                    </span>
                    <Change from={r.old} to={r.new} />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {progress && (
            <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
              {progress}
            </span>
          )}
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={doApply} disabled={busy || !!error || chosen.length === 0}>
            {busy ? 'Replacing…' : `Replace ${plural(chosen.length, 'value')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
