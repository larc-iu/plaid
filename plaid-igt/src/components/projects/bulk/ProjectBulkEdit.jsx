import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ArrowRight, Replace, ReplaceAll, Wand2, Merge } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTabParam } from '@/hooks/useTabParam';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { buildHomonymIndex } from '@/domain/vocabHomonyms';
import { normalizeVocabFields, humanizeFieldName } from '@/domain/vocabFields';
import { readVocabFields } from '@/domain/igtConfig';
import {
  analysisViolations,
  governedFields,
  isValueAllowed,
  readTagsetName,
  resolveTagset,
  tagsetEnforces,
} from '@/domain/tagsets';
import { MATCH_TYPES, searchDomains } from '../search/searchQueries.js';
import { MarkedText } from '../search/MarkedText.jsx';
import { hitTo, rememberCaret } from '../search/hitLinks.js';
import {
  OPERATIONS,
  buildReplacer,
  groupByDoc,
  tallyCandidates,
  analysisLabel,
  cardRowsFor,
  chainText,
} from './bulkPlan.js';
import {
  planRespell,
  applyRespell,
  planField,
  applyField,
  planReanalyze,
  applyReanalyze,
  planMerge,
  applyMerge,
} from './bulkRunner.js';
import { AnalysisCard } from './AnalysisCard.jsx';

// The Bulk Edit workbench: pick an operation, describe the change, preview
// every match as a checkbox row (grouped by document, each row a link into
// the editor), then apply the ticked rows under one audit operation. The
// shape is FLEx's Change Spelling / Bulk Edit dialogs — filter, tick, preview,
// apply — with the Search tab's matching underneath.
//
// Everything that touches the server lives in bulkRunner.js; the row shapes
// and match logic in bulkPlan.js. This file is the forms, the row list, and
// the confirm step.

const plural = (n, word, words = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : words}`;

// ---- shared bits ----------------------------------------------------------------

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
  <span className="inline-flex items-center gap-1 font-mono text-sm">
    <span className="rounded bg-red-50 px-1 text-red-800 line-through decoration-red-400">
      {from === '' ? '∅' : from}
    </span>
    <ArrowRight className="h-3 w-3 text-muted-foreground" />
    <span className="rounded bg-green-50 px-1 text-green-800">{to === '' ? '∅' : to}</span>
  </span>
);

// Per-run state: busy flag, progress line, and the plan + selection.
const useRun = () => {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  // `reset` drops the previous plan and selection up front, so a re-run with
  // different input never shows stale results under the progress line.
  const run = async (label, fn, { reset = false } = {}) => {
    if (busy) return null;
    setBusy(true);
    setProgress('');
    if (reset) {
      setPlan(null);
      setSelected(new Set());
    }
    try {
      return await fn((done, total) => setProgress(`Loading document ${done} of ${total}…`));
    } catch (err) {
      console.error(`${label}:`, err);
      notifyError(humanizeError(err, `${label} failed.`), label);
      return null;
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const toggle = (id, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleMany = (ids, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  return { busy, progress, plan, setPlan, selected, setSelected, run, toggle, toggleMany };
};

// The document-grouped match list. `renderRow(row)` fills the cell after the
// checkbox; the sentence context is the same for every operation.
const MatchGroups = ({ projectId, rows, selected, toggle, toggleMany, renderRow, dim }) => {
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

const SelectionSummary = ({ rows, selected, setSelected, extra }) => {
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
const ApplyBar = ({ count, busy, summary, onApply, children }) => {
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
const SubstitutionFields = ({ find, setFind, matchType, setMatchType, repl, setRepl, onEnter }) => (
  <div className="flex flex-wrap items-end gap-2">
    <div className="flex min-w-48 flex-1 flex-col gap-1">
      <Label htmlFor="bulk-find">Find</Label>
      <Input
        id="bulk-find"
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
        value={repl}
        onChange={(e) => setRepl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        placeholder={matchType === 'regex' ? 'replacement, $1 for groups' : 'replacement'}
        spellCheck={false}
      />
    </div>
  </div>
);

const Progress = ({ text }) =>
  text ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary" />
      {text}
    </p>
  ) : null;

// ---- respell -------------------------------------------------------------------

// Before/after for one word: the word row, and (when the word has a morpheme
// chain of its own) the chain row beneath it, laid out on one grid so the
// two arrows line up, with the after column hugging the before column.
// Shared by the respell and field previews: `lines` is [{ label, cls, from,
// to }], where a line without `to` is context (the word a gloss sits under)
// rather than a change.
const SCOPE_CLS = {
  word: 'text-blue-700',
  morpheme: 'text-violet-700',
  sentence: 'text-green-700',
};
const ChangeGrid = ({ lines }) => {
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

const RespellChange = ({ row, includeMorphemes }) => {
  const chain = row.chain ? chainText(row.chain, includeMorphemes) : null;
  return (
    <ChangeGrid
      lines={[
        { label: 'Word', cls: SCOPE_CLS.word, from: row.old, to: row.new },
        ...(chain
          ? [{ label: 'Morphemes', cls: SCOPE_CLS.morpheme, from: chain.old, to: chain.new }]
          : []),
      ]}
    />
  );
};

// One field match: the word (and morpheme) it sits under as context, then the
// field's before → after.
const FieldChange = ({ row, target }) => {
  const lines = [];
  if (row.word != null) lines.push({ label: 'Word', cls: SCOPE_CLS.word, from: row.word });
  if (row.morpheme != null)
    lines.push({ label: 'Morpheme', cls: SCOPE_CLS.morpheme, from: row.morpheme });
  const scope = target.kind === 'morpheme' ? 'morpheme' : target.scope;
  lines.push({
    label: target.kind === 'morpheme' ? 'Morpheme form' : target.field,
    cls: SCOPE_CLS[scope],
    from: row.old,
    to: row.new,
  });
  return (
    <>
      <ChangeGrid lines={lines} />
      {row.invalid && (
        <p className="mt-1 text-xs text-destructive">Outside the tagset, so it will be skipped.</p>
      )}
    </>
  );
};

const RespellPanel = ({ project, projectId, client, layerInfo }) => {
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const [includeMorphemes, setIncludeMorphemes] = useState(true);
  const [includeLexicon, setIncludeLexicon] = useState(true);
  const r = useRun();

  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );

  const preview = async () => {
    if (!find || error) return;
    const plan = await r.run(
      'Preview',
      (onProgress) =>
        planRespell(client, project, layerInfo, { find, matchType, apply }, onProgress),
      { reset: true },
    );
    if (!plan) return;
    r.setPlan({ ...plan, find, repl });
    r.setSelected(new Set([...plan.rows, ...plan.lexiconRows].map((x) => x.id)));
  };

  const plan = r.plan;
  const selectedRows = plan ? plan.rows.filter((x) => r.selected.has(x.id)) : [];
  const selectedLex = plan ? plan.lexiconRows.filter((x) => r.selected.has(x.id)) : [];
  const morphCount = includeMorphemes
    ? selectedRows.reduce((a, x) => a + x.morphemes.length, 0)
    : 0;
  const total = selectedRows.length + (includeLexicon ? selectedLex.length : 0);

  const doApply = async () => {
    const res = await r.run('Apply', () =>
      applyRespell(
        client,
        { rows: selectedRows, lexiconRows: selectedLex },
        {
          includeMorphemes,
          includeLexicon,
          label: `Respell “${plan.find}” → “${plan.repl}”`,
        },
      ),
    );
    if (!res) return;
    notifySuccess(
      `${plural(res.wordsChanged, 'word')} in ${plural(res.docsChanged, 'document')}` +
        (res.morphemesChanged ? `, ${plural(res.morphemesChanged, 'morpheme form')}` : '') +
        (res.entriesChanged
          ? `, ${plural(res.entriesChanged, 'lexicon entry', 'lexicon entries')}`
          : '') +
        ' respelled.',
      'Respelled',
    );
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <SubstitutionFields
          {...{ find, setFind, matchType, setMatchType, repl, setRepl }}
          onEnter={preview}
        />
        {error && <p className="text-sm text-destructive">Check your regex: {error}</p>}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={includeMorphemes} onChange={setIncludeMorphemes} />
            Also respell morpheme forms
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={includeLexicon} onChange={setIncludeLexicon} />
            Also respell lexicon entries
          </label>
          <Button className="ml-auto" onClick={preview} disabled={r.busy || !find || !!error}>
            {r.busy && !plan ? 'Searching…' : 'Preview'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Whole words are respelled in the baseline text; every word keeps its morphemes, glosses,
          and lexicon links. Text outside words (punctuation between them, gaps) is left alone.
        </p>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          <ApplyBar
            count={total}
            busy={r.busy}
            onApply={doApply}
            summary={`${plural(selectedRows.length, 'word')} will be respelled${
              morphCount ? `, along with ${plural(morphCount, 'morpheme form')}` : ''
            }${
              includeLexicon && selectedLex.length
                ? `, and ${plural(selectedLex.length, 'lexicon entry', 'lexicon entries')}`
                : ''
            }.`}
          >
            <SelectionSummary
              rows={[...plan.rows, ...plan.lexiconRows]}
              selected={r.selected}
              setSelected={r.setSelected}
            />
          </ApplyBar>
          {plan.rows.length === 0 && plan.lexiconRows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching words.</p>
          )}
          <MatchGroups
            projectId={projectId}
            rows={plan.rows}
            selected={r.selected}
            toggle={r.toggle}
            toggleMany={r.toggleMany}
            renderRow={(row) => <RespellChange row={row} includeMorphemes={includeMorphemes} />}
          />
          {plan.lexiconRows.length > 0 && (
            <div className={cn('rounded-lg border bg-card', !includeLexicon && 'opacity-60')}>
              <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
                <Checkbox
                  checked={selectedLex.length === plan.lexiconRows.length}
                  indeterminate={selectedLex.length > 0}
                  onChange={(v) =>
                    r.toggleMany(
                      plan.lexiconRows.map((x) => x.id),
                      v,
                    )
                  }
                  disabled={!includeLexicon}
                />
                <span className="text-sm font-medium">Lexicon entries</span>
                <span className="text-xs text-muted-foreground">
                  {selectedLex.length} of {plural(plan.lexiconRows.length, 'entry', 'entries')}{' '}
                  selected{!includeLexicon && ' (not included)'}
                </span>
              </div>
              <div className="divide-y">
                {plan.lexiconRows.map((x) => (
                  <div key={x.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={r.selected.has(x.id)}
                      onChange={(v) => r.toggle(x.id, v)}
                      disabled={!includeLexicon}
                    />
                    <Change from={x.old} to={x.new} />
                    <span className="text-xs text-muted-foreground">{x.vocabName}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ---- field ----------------------------------------------------------------------

// The tagset governing a replace target, or null. Only annotation fields have
// one: a morpheme form is a form, not an annotation. A bulk replace is a write
// like any other, so an enforcing tagset has to bite here too — otherwise the
// rule is bypassable from inside the app that enforces it.
const tagsetForTarget = (target, layerInfo, project) => {
  if (!target || target.kind !== 'span') return null;
  const layer = (layerInfo?.spanLayers?.[target.scope] || []).find((l) => l.id === target.layerId);
  if (!layer) return null;
  const t = resolveTagset(layer.config, project?.config);
  // The name rides along so the warning can say which list refused the values.
  return t ? { ...t, name: readTagsetName(layer.config) } : null;
};

const FieldPanel = ({ project, projectId, client, layerInfo }) => {
  const targets = useMemo(
    () => searchDomains(layerInfo, []).filter((d) => d.kind === 'span' || d.kind === 'morpheme'),
    [layerInfo],
  );
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const r = useRun();
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  const tagset = useMemo(
    () => tagsetForTarget(target, layerInfo, project),
    [target, layerInfo, project],
  );
  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );

  const grouped = useMemo(() => {
    const fields = targets.filter((d) => d.kind === 'span');
    const morph = targets.filter((d) => d.kind === 'morpheme');
    return [
      ...(fields.length ? [{ label: 'Annotations', items: fields }] : []),
      ...(morph.length
        ? [{ label: 'Forms', items: morph.map((d) => ({ ...d, label: 'Morpheme form' })) }]
        : []),
    ];
  }, [targets]);

  const preview = async () => {
    if (!find || error || !target) return;
    const plan = await r.run(
      'Preview',
      (onProgress) => planField(client, project, target, { find, matchType, apply }, onProgress),
      { reset: true },
    );
    if (!plan) return;
    // An enforcing tagset refuses the values this replace would produce. Flag
    // rows and leave them unticked rather than blocking the whole preview: the
    // rest of the replace is usually fine, and seeing WHICH values are refused
    // is how you decide whether to fix the replacement or the tagset.
    const rows = tagsetEnforces(tagset)
      ? plan.rows.map((x) => (isValueAllowed(x.new, tagset) ? x : { ...x, invalid: true }))
      : plan.rows;
    r.setPlan({ ...plan, rows, find, repl, target, tagset });
    r.setSelected(new Set(rows.filter((x) => !x.invalid).map((x) => x.id)));
  };

  const plan = r.plan;
  const selectedRows = plan ? plan.rows.filter((x) => r.selected.has(x.id)) : [];
  const targetLabel = plan?.target?.kind === 'morpheme' ? 'morpheme form' : plan?.target?.field;

  const doApply = async () => {
    // Ticking a flagged row by hand does not make it writable: the same rule
    // that stops it being typed stops it being bulk-written.
    const writable = selectedRows.filter((x) => !x.invalid);
    const res = await r.run('Apply', () =>
      applyField(
        client,
        { rows: writable },
        { label: `Replace “${plan.find}” → “${plan.repl}” in ${targetLabel}` },
      ),
    );
    if (!res) return;
    notifySuccess(`${plural(res.changed, 'value')} replaced in ${targetLabel}.`, 'Replaced');
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <Label>In</Label>
          <Select value={target?.id ?? ''} onValueChange={setTargetId}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="Choose a field" />
            </SelectTrigger>
            <SelectContent>
              {grouped.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.items.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SubstitutionFields
          {...{ find, setFind, matchType, setMatchType, repl, setRepl }}
          onEnter={preview}
        />
        {error && <p className="text-sm text-destructive">Check your regex: {error}</p>}
        <div className="flex items-center">
          <Button
            className="ml-auto"
            onClick={preview}
            disabled={r.busy || !find || !!error || !target}
          >
            {r.busy && !plan ? 'Searching…' : 'Preview'}
          </Button>
        </div>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          <ApplyBar
            count={selectedRows.filter((x) => !x.invalid).length}
            busy={r.busy}
            onApply={doApply}
            summary={`${plural(selectedRows.filter((x) => !x.invalid).length, 'value')} in ${targetLabel} will be replaced.`}
          >
            <SelectionSummary rows={plan.rows} selected={r.selected} setSelected={r.setSelected} />
          </ApplyBar>
          {plan.rows.some((x) => x.invalid) && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {plural(plan.rows.filter((x) => x.invalid).length, 'value')} would fall outside the{' '}
              <strong>{plan.tagset?.name ?? 'field'}</strong> tagset and cannot be written. Those
              rows are marked and will be skipped.
            </p>
          )}
          {plan.rows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching values.</p>
          )}
          <MatchGroups
            projectId={projectId}
            rows={plan.rows}
            selected={r.selected}
            toggle={r.toggle}
            toggleMany={r.toggleMany}
            renderRow={(row) => <FieldChange row={row} target={plan.target} />}
          />
        </>
      )}
    </div>
  );
};

// ---- reanalyze -----------------------------------------------------------------

const ReanalyzePanel = ({ project, projectId, client, layerInfo }) => {
  const [form, setForm] = useState('');
  const [targetSig, setTargetSig] = useState(null);
  const r = useRun();
  const cardRows = useMemo(() => cardRowsFor(layerInfo, project), [layerInfo, project]);

  // Re-analyze spreads ONE analysis to every occurrence, so a single off-tagset
  // value in the chosen target lands everywhere at once. Judge the analysis
  // before any of it is written, rather than each row as field-replace does.
  const tagsetFor = useMemo(() => {
    const by = new Map(
      governedFields(layerInfo, project?.config).map((g) => [`${g.scope}:${g.field}`, g.tagset]),
    );
    return (scope, field) => by.get(`${scope}:${field}`) ?? null;
  }, [layerInfo, project?.config]);

  const preview = async () => {
    if (!form.trim()) return;
    setTargetSig(null);
    const plan = await r.run(
      'Preview',
      (onProgress) => planReanalyze(client, project, layerInfo, form.trim(), onProgress),
      { reset: true },
    );
    if (!plan) return;
    const candidates = tallyCandidates(plan.rows);
    r.setPlan({ ...plan, form: form.trim(), candidates });
    const sig = candidates[0]?.signature ?? null;
    setTargetSig(sig);
    r.setSelected(new Set(plan.rows.filter((x) => x.signature !== sig).map((x) => x.id)));
  };

  const plan = r.plan;
  const target = plan?.candidates.find((c) => c.signature === targetSig) ?? null;
  const targetBad = target ? analysisViolations(target.analysis, tagsetFor) : [];
  const targetName = target
    ? `Analysis ${plan.candidates.findIndex((c) => c.signature === targetSig) + 1}`
    : '';
  const label = (a) => analysisLabel(a, plan?.itemFormById);

  // Switching the target re-derives the default selection: everything that
  // doesn't already carry it.
  const chooseTarget = (sig) => {
    setTargetSig(sig);
    r.setSelected(new Set(plan.rows.filter((x) => x.signature !== sig).map((x) => x.id)));
  };

  const selectedRows = plan
    ? plan.rows.filter((x) => r.selected.has(x.id) && x.signature !== targetSig)
    : [];

  const doApply = async () => {
    if (!target || targetBad.length) return;
    const res = await r.run('Apply', () =>
      applyReanalyze(
        client,
        { rows: selectedRows, docs: plan.docs },
        {
          analysis: target.analysis,
          label: `Re-analyze “${plan.form}” as ${label(target.analysis)}`,
          onError: (msg) => notifyError(msg, 'Re-analyze'),
        },
      ),
    );
    if (!res) return;
    if (res.failedDoc) {
      notifyWarning(
        `${plural(res.changed, 'occurrence')} re-analyzed before “${res.failedDoc}” failed. The remaining documents were not changed.`,
        'Stopped early',
      );
    } else {
      notifySuccess(
        `${plural(res.changed, 'occurrence')} of “${plan.form}” re-analyzed.`,
        'Re-analyzed',
      );
    }
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="bulk-form">Word form</Label>
            <Input
              id="bulk-form"
              value={form}
              onChange={(e) => setForm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && preview()}
              placeholder="exactly as it appears in the baseline"
            />
          </div>
          <Button onClick={preview} disabled={r.busy || !form.trim()}>
            {r.busy && !plan ? 'Searching…' : 'Find occurrences'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Lists every occurrence of the word with the analysis it carries now. Pick the analysis
          that should win; the ticked occurrences get it (segmentation, glosses, and links),
          replacing whatever they had.
        </p>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          {plan.candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {plan.rows.length === 0
                ? `No occurrences of “${plan.form}”.`
                : `“${plan.form}” occurs ${plural(plan.rows.length, 'time')}, but none of them is analyzed yet. Analyze one in a document first; then it can be applied to the rest here.`}
            </p>
          ) : (
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 text-sm font-medium">Apply this analysis</p>
              <div className="flex flex-col gap-2">
                {plan.candidates.map((c, i) => (
                  <label
                    key={c.signature}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 hover:bg-muted/30',
                      targetSig === c.signature && 'border-primary bg-primary/5',
                    )}
                  >
                    <input
                      type="radio"
                      name="bulk-analysis"
                      checked={targetSig === c.signature}
                      onChange={() => chooseTarget(c.signature)}
                      className="mt-1 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className="text-sm font-semibold">Analysis {i + 1}</span>
                        <span className="text-xs text-muted-foreground">
                          {plural(c.count, 'occurrence')}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <AnalysisCard
                          word={plan.form}
                          analysis={c.analysis}
                          rows={cardRows}
                          itemFormById={plan.itemFormById}
                        />
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
          {targetBad.length > 0 && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              This analysis holds{' '}
              {targetBad.map((b, i) => (
                <Fragment key={`${b.scope}:${b.field}`}>
                  {i > 0 && ', '}
                  <strong>{b.value}</strong> in {b.field} ({b.scope})
                </Fragment>
              ))}
              , which its tagset does not allow. Applying it would put that value on every ticked
              occurrence at once, so pick a different analysis or fix this one in its document
              first.
            </p>
          )}
          {target && (
            <ApplyBar
              count={targetBad.length ? 0 : selectedRows.length}
              busy={r.busy}
              onApply={doApply}
              summary={`${plural(selectedRows.length, 'occurrence')} of “${plan.form}” will be re-analyzed as ${label(target.analysis)}, replacing their current analyses.`}
            >
              <SelectionSummary
                rows={plan.rows.filter((x) => x.signature !== targetSig)}
                selected={r.selected}
                setSelected={r.setSelected}
                extra={
                  <>
                    {' '}
                    ({plural(target.count, 'occurrence')} {target.count === 1 ? 'has' : 'have'}{' '}
                    {targetName})
                  </>
                }
              />
            </ApplyBar>
          )}
          {plan.rows.length > 0 && (
            <MatchGroups
              projectId={projectId}
              rows={plan.rows}
              selected={r.selected}
              toggle={r.toggle}
              toggleMany={r.toggleMany}
              dim={(row) => row.signature === targetSig}
              renderRow={(row) =>
                row.signature === targetSig ? (
                  <span className="text-xs text-muted-foreground">has {targetName}</span>
                ) : (
                  <div className="min-w-0 max-w-full overflow-x-auto">
                    <AnalysisCard
                      word={plan.form}
                      analysis={row.analysis}
                      rows={cardRows}
                      itemFormById={plan.itemFormById}
                      labels={false}
                    />
                  </div>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
};

// ---- merge ----------------------------------------------------------------------

// Metadata keys that are bookkeeping rather than content: import identifiers
// and provenance. Everything else on an entry is shown when it is ticked.
const isBookkeepingKey = (k) => k === 'flexEntry' || k === 'flexSense' || k.startsWith('prov');

// The whole of one lexicon entry (minus its attestations): every configured
// field in schema order, then any other content the entry carries (custom
// keys, a FLEx homograph number, example sentences). Shown under a ticked row
// so what survives and what is lost in a merge is plain to see.
const EntryDetail = ({ item, fields }) => {
  const meta = item.metadata || {};
  const known = new Set(fields.map((f) => f.name));
  const extras = Object.keys(meta).filter(
    (k) => !known.has(k) && !isBookkeepingKey(k) && k !== 'examples' && k !== 'homograph',
  );
  const examples = Array.isArray(meta.examples) ? meta.examples.filter((ex) => ex?.text) : [];
  const homograph = Number(meta.homograph) || 0;
  const show = (v) =>
    v == null || String(v).trim() === '' ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      String(v)
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm">
      {fields.map((f) => (
        <Fragment key={f.name}>
          <dt className="text-xs text-muted-foreground">{humanizeFieldName(f.name)}</dt>
          <dd>{show(meta[f.name])}</dd>
        </Fragment>
      ))}
      {extras.map((k) => (
        <Fragment key={k}>
          <dt className="text-xs text-muted-foreground">{humanizeFieldName(k)}</dt>
          <dd>{show(typeof meta[k] === 'object' ? JSON.stringify(meta[k]) : meta[k])}</dd>
        </Fragment>
      ))}
      {homograph > 0 && (
        <>
          <dt className="text-xs text-muted-foreground">FLEx homograph</dt>
          <dd>{homograph}</dd>
        </>
      )}
      {examples.length > 0 && (
        <>
          <dt className="text-xs text-muted-foreground">Examples</dt>
          <dd>
            <ul className="flex flex-col gap-0.5">
              {examples.map((ex, i) => (
                <li key={i}>
                  {ex.text}
                  {ex.translation && (
                    <span className="block text-xs text-muted-foreground">{ex.translation}</span>
                  )}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
};

const MergePanel = ({ project, client }) => {
  const vocabs = project.vocabs || [];
  const [vocabId, setVocabId] = useState(vocabs[0]?.id ?? '');
  const [items, setItems] = useState(null);
  const [fields, setFields] = useState([]);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState(() => new Set());
  const [survivor, setSurvivor] = useState(null);
  const r = useRun();

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setChosen(new Set());
    setSurvivor(null);
    r.setPlan(null);
    if (!vocabId) return undefined;
    client.vocabLayers
      .get(vocabId, true)
      .then((layer) => {
        if (cancelled) return;
        setItems(layer.items || []);
        setFields(normalizeVocabFields(readVocabFields(layer.config)));
      })
      .catch((err) => {
        console.error('Load vocabulary failed:', err);
        if (!cancelled) notifyError(humanizeError(err, 'Could not load the vocabulary.'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabId, client]);

  const homonyms = useMemo(() => buildHomonymIndex(items || []), [items]);
  const shown = useMemo(() => {
    if (!items) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? items.filter((it) => (it.form || '').toLowerCase().includes(q)) : items;
    return [...list].sort((a, b) => (a.form || '').localeCompare(b.form || '')).slice(0, 200);
  }, [items, filter]);
  const itemById = useMemo(() => new Map((items || []).map((it) => [it.id, it])), [items]);

  const pick = (id, on) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    if (on && survivor == null) setSurvivor(id);
    if (!on && survivor === id) setSurvivor(null);
    r.setPlan(null);
  };

  const losers = [...chosen].filter((id) => id !== survivor);

  const preview = async () => {
    if (!survivor || losers.length === 0) return;
    const plan = await r.run(
      'Preview',
      (onProgress) => planMerge(client, project, vocabId, losers, onProgress),
      { reset: true },
    );
    if (plan) r.setPlan(plan);
  };

  const plan = r.plan;
  // The at-a-glance line for an unticked entry: its inline fields (the ones
  // the vocabulary table shows as columns), values only.
  const inlineLine = (it) =>
    fields
      .filter((f) => f.inline)
      .map((f) => it.metadata?.[f.name])
      .filter((v) => v != null && String(v).trim() !== '')
      .join(' · ');

  const doApply = async () => {
    const survivorItem = itemById.get(survivor);
    const res = await r.run('Apply', () =>
      applyMerge(
        client,
        { links: plan.links },
        {
          survivorId: survivor,
          loserIds: losers,
          label: `Merge ${plural(losers.length, 'lexicon entry', 'lexicon entries')} into “${survivorItem?.form ?? ''}”`,
        },
      ),
    );
    if (!res) return;
    notifySuccess(
      `${plural(res.entriesRemoved, 'entry', 'entries')} merged; ${plural(res.linksMoved, 'link')} moved to “${survivorItem?.form ?? ''}”.`,
      'Merged',
    );
    setItems((prev) => (prev || []).filter((it) => !chosen.has(it.id) || it.id === survivor));
    setChosen(new Set());
    setSurvivor(null);
    r.setPlan(null);
  };

  if (vocabs.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This project has no linked vocabulary.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          {vocabs.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label>Vocabulary</Label>
              <Select value={vocabId} onValueChange={setVocabId}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vocabs.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="bulk-merge-filter">Find entries</Label>
            <Input
              id="bulk-merge-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by form"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Tick the entries to merge and choose which one survives. Every word and morpheme linked to
          the others is re-linked to the survivor; the survivor’s own fields are kept as they are
          and the other entries are deleted.
        </p>
      </div>

      {items && (
        <div className="rounded-lg border bg-card">
          <div className="grid grid-cols-[3.5rem_3rem_1fr] items-center border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="text-center">Merge</span>
            <span className="text-center">Keep</span>
            <span>Entry</span>
          </div>
          <div className="divide-y">
            {shown.map((it) => {
              const on = chosen.has(it.id);
              const idx = homonyms.get(it.id);
              return (
                <div
                  key={it.id}
                  className={cn(
                    'grid grid-cols-[3.5rem_3rem_1fr] items-center px-3 py-1.5 text-sm',
                    on && 'bg-muted/30',
                  )}
                >
                  <Checkbox
                    checked={on}
                    onChange={(v) => pick(it.id, v)}
                    className="h-4 w-4 cursor-pointer justify-self-center accent-primary"
                  />
                  <input
                    type="radio"
                    name="bulk-survivor"
                    checked={survivor === it.id}
                    disabled={!on}
                    onChange={() => {
                      setSurvivor(it.id);
                      r.setPlan(null);
                    }}
                    className="justify-self-center accent-primary disabled:opacity-30"
                    title="Keep this entry"
                  />
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{it.form}</span>
                    {idx != null && (
                      <sub className="ml-0.5 text-[0.7em] text-muted-foreground">{idx}</sub>
                    )}
                    {!on && inlineLine(it) && (
                      <span className="ml-2 text-xs text-muted-foreground">{inlineLine(it)}</span>
                    )}
                  </span>
                  {on && (
                    <div className="col-start-3 pb-1 pt-1">
                      <EntryDetail item={it} fields={fields} />
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No entries.</p>
            )}
            {items.length > 200 && shown.length === 200 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Showing the first 200; narrow the filter to find others.
              </p>
            )}
          </div>
        </div>
      )}

      {chosen.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
          <span>
            {plural(chosen.size, 'entry', 'entries')} ticked
            {survivor && (
              <>
                , keeping <strong>{itemById.get(survivor)?.form}</strong>
              </>
            )}
          </span>
          <Button
            className="ml-auto"
            variant="outline"
            onClick={preview}
            disabled={r.busy || !survivor || losers.length === 0}
          >
            {r.busy && !plan ? 'Counting links…' : 'Preview'}
          </Button>
        </div>
      )}
      <Progress text={r.progress} />
      {plan && survivor && (
        <ApplyBar
          count={losers.length}
          busy={r.busy}
          onApply={doApply}
          summary={`${plural(losers.length, 'entry', 'entries')} will be merged into “${itemById.get(survivor)?.form}”: ${plural(plan.links.length, 'link')} in ${plural(new Set(plan.links.map((l) => l.docId)).size, 'document')} move to it, and the merged entries are deleted.`}
        >
          <span className="text-sm">
            {losers.map((id) => itemById.get(id)?.form).join(', ')} →{' '}
            <strong>{itemById.get(survivor)?.form}</strong>:{' '}
            {plural(plan.links.length, 'linked word or morpheme', 'linked words and morphemes')} in{' '}
            {plural(new Set(plan.links.map((l) => l.docId)).size, 'document')} will follow.
          </span>
        </ApplyBar>
      )}
    </div>
  );
};

// ---- the tab -------------------------------------------------------------------

const ICONS = { respell: Replace, field: ReplaceAll, reanalyze: Wand2, merge: Merge };
const PANELS = {
  respell: RespellPanel,
  field: FieldPanel,
  reanalyze: ReanalyzePanel,
  merge: MergePanel,
};
const OP_IDS = OPERATIONS.map((o) => o.id);

// Same layout as the Settings tab: the activities as a vertical tab list on
// the left, the chosen activity (with its own title and explainer) on the
// right. The activity rides in `?op=` next to `?tab=bulk`, so a reload or a
// shared link lands on the same one.
export const ProjectBulkEdit = ({ project, projectId, client }) => {
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const [op, setOp] = useTabParam(OP_IDS, 'respell', 'op');

  if (!layerInfo.primaryTokenLayer) {
    return (
      <p className="tw py-10 text-center text-sm text-muted-foreground">
        This project has no word layer to edit.
      </p>
    );
  }

  const panelProps = { project, projectId, client, layerInfo };
  return (
    <Tabs
      orientation="vertical"
      value={op}
      onValueChange={setOp}
      className="tw flex flex-col gap-6 sm:flex-row sm:items-start"
    >
      <TabsList className="h-auto w-full shrink-0 flex-col items-stretch justify-start gap-0.5 border-b-0 bg-transparent p-0 sm:w-52 sm:border-r sm:pr-3">
        {OPERATIONS.map((o) => {
          const Icon = ICONS[o.id];
          return (
            <TabsTrigger
              key={o.id}
              value={o.id}
              to={`/projects/${projectId}?tab=bulk${o.id === 'respell' ? '' : `&op=${o.id}`}`}
              className="w-full justify-start gap-2 rounded-md border-b-0 px-3 py-2 data-[state=active]:bg-muted data-[state=active]:text-foreground"
            >
              <Icon className="h-4 w-4 shrink-0" /> {o.label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="min-w-0 flex-1">
        {OPERATIONS.map((o) => {
          const Panel = PANELS[o.id];
          return (
            <TabsContent key={o.id} value={o.id} className="mt-0">
              <div className="mb-4">
                <h2 className="text-lg font-semibold">{o.label}</h2>
                <p className="text-sm text-muted-foreground">{o.blurb}</p>
              </div>
              {op === o.id && <Panel {...panelProps} />}
            </TabsContent>
          );
        })}
      </div>
    </Tabs>
  );
};
