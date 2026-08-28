// Bulk add: paste or upload a table of entries, say what its columns hold, and
// review how it merges with what the vocabulary already has before committing.
//
// Three steps, because the realistic import is a few thousand rows from a
// dictionary kept in another tool against a vocabulary already built from
// texts. Nobody can eyeball that, so the merge has to be planned, summarized,
// and reviewable (see import/vocabBulk.js for the merge rules) before a single
// write goes out.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileText, X, ArrowLeft, ArrowRight, Download, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { FLEX_MORPH_TYPES } from '@/domain/affixMarkers';
import { humanizeFieldName, fieldDescription } from '@/domain/vocabFields';
import { downloadBlob, sanitizeFilename } from '@/export/files';
import {
  FORM,
  IGNORE,
  ENRICH_FILL,
  ENRICH_SKIP,
  CONFLICT_SKIP,
  CONFLICT_NEW,
  CONFLICT_OVERWRITE,
  AMBIGUOUS_SKIP,
  AMBIGUOUS_NEW,
  DEFAULT_STRATEGIES,
  OVERRIDE_VALUES,
  parseTable,
  delimiterName,
  guessColumns,
  rowsToEntries,
  planVocabImport,
  countRejected,
  serializeImportReport,
} from '@/import/vocabBulk';

// One bulkCreate carries this many entries: the server caps a JSON body at
// 10MB, and a few hundred KB per request also gives the progress line
// something to say during a long import.
const CREATE_CHUNK = 1000;
// One metadata patch is one batch op, and plaid-core caps a batch at 1000.
const UPDATE_CHUNK = 500;

// The three steps a person walks. `running` is an outcome, not a step, so it
// carries its own title and no counter.
const STEPS = {
  source: { title: 'Bulk Add Items', n: 1 },
  columns: { title: 'Map Columns', n: 2 },
  review: { title: 'Review Changes', n: 3 },
};
const WIZARD_STEPS = Object.keys(STEPS).length;

const PREVIEW_ROWS = 25;
// Entries sharing a form, beyond which the list just says how many more.
const MAX_MATCHES = 4;
const SAMPLE_VALUES = 3;

// How each outcome reads in the row list. A replace is called out separately
// from a fill: one adds to an entry, the other overwrites what somebody put
// there by hand, and the amber says which.
const actionLabel = (d) => {
  if (d.action === 'create') return 'will be added';
  if (d.action === 'merge') return 'folded into a new entry above';
  if (d.action === 'update')
    return d.kind === 'conflict' ? 'will be replaced' : 'will be filled in';
  return 'skipped';
};
const actionTone = (d) => {
  if (d.action === 'skip') return 'text-muted-foreground';
  if (d.action === 'update' && d.kind === 'conflict') return 'text-amber-700';
  return 'text-emerald-600';
};

// Short labels for the per-row choice. The bucket dropdowns say the same thing
// at length, since there the subject is a whole pile of rows.
const ROW_CHOICES = {
  fill: 'Fill in blanks',
  skip: 'Skip',
  new: 'Add',
  overwrite: 'Replace values',
};

// The same choices spelled out for the bucket dropdowns, where the subject is
// a whole pile of rows rather than one.
const BUCKET_CHOICES = {
  enrich: [
    [ENRICH_FILL, 'Fill in the blank fields'],
    [ENRICH_SKIP, 'Leave the existing entry alone'],
  ],
  conflict: [
    [CONFLICT_SKIP, "Skip them, keep what's here"],
    [CONFLICT_NEW, 'Add each as a separate entry'],
    [CONFLICT_OVERWRITE, 'Replace the existing values'],
  ],
  ambiguous: [
    [AMBIGUOUS_SKIP, 'Skip them'],
    [AMBIGUOUS_NEW, 'Add each as a separate entry'],
  ],
};

// Views over the plan. "Needs a decision" is first and is the default whenever
// it has anything in it: those are the rows the tool cannot judge on its own,
// and they are precisely what a person is here to look at.
const FILTERS = {
  decide: {
    label: 'Needs a decision',
    match: (d) => d.kind === 'conflict' || d.kind === 'ambiguous',
  },
  changes: { label: 'Will change something', match: (d) => d.action !== 'skip' },
  all: { label: 'Every row', match: () => true },
  new: { label: 'New entries', match: (d) => d.kind === 'new' },
  enrich: { label: 'Fills in blanks', match: (d) => d.kind === 'enrich' },
  identical: { label: 'Already present', match: (d) => d.kind === 'identical' },
  blank: { label: 'No form', match: (d) => d.kind === 'blank' },
};

const selectClass =
  'h-8 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60';

const n = (x) => x.toLocaleString();

// Morph types are a controlled vocabulary. Accept any casing an external
// dictionary uses, and drop what isn't in the inventory rather than storing a
// value the interlinear renderer can't interpret.
const MORPH_BY_KEY = new Map(
  FLEX_MORPH_TYPES.map((t) => [t.toLowerCase().replace(/[\s_-]+/g, ''), t]),
);
const normalizeValue = (field, raw) =>
  field === 'morphType' ? (MORPH_BY_KEY.get(raw.toLowerCase().replace(/[\s_-]+/g, '')) ?? '') : raw;

// A summary row in the review step: count, what it means, and the choice (if
// any) the user has about it.
const Bucket = ({ tone, count, label, children }) =>
  count === 0 ? null : (
    <div className="flex items-start gap-3 border-b py-2 last:border-b-0">
      <span
        className={cn(
          'min-w-[4.5rem] text-right text-sm font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {n(count)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </div>
  );

// Whether two values are the same as far as the merge is concerned. Mirrors the
// planner's comparison so the highlighting agrees with the decision.
const sameValue = (a, b) =>
  String(a ?? '')
    .trim()
    .normalize('NFC') ===
  String(b ?? '')
    .trim()
    .normalize('NFC');

// One entry's value for one field, tinted by how it relates to the other side:
// amber where the two disagree, green where this side alone supplies it.
const ValueCell = ({ value, clash, add }) => (
  <td className="break-words px-1 align-top">
    <span
      className={cn(
        clash && 'font-semibold text-amber-700',
        add && 'font-semibold text-emerald-700',
      )}
    >
      {value || ''}
    </span>
  </td>
);

// One decision, laid out so the judgement is possible: what the file says, what
// is already in the vocabulary that it collided with, and the choice. The two
// sides share a column per field so they can be read down rather than
// re-scanned across. Showing the matched entries at all is the whole point.
// "differs on gloss" is not something you can act on without seeing the entry
// it differs from.
const DecisionRow = ({ d, columns, override, fallback, onChoose }) => {
  const has = (values, f) => String(values?.[f] ?? '').trim() !== '';
  // A field the file supplies that no matched entry has: new information.
  const added = new Set(
    columns.filter((f) => has(d.values, f) && d.matches.every((m) => !has(m.values, f))),
  );
  const clashWith = (m) =>
    new Set(
      columns.filter(
        (f) => has(m.values, f) && has(d.values, f) && !sameValue(m.values[f], d.values[f]),
      ),
    );
  // Against the row, every disagreement across the matches it was weighed on.
  const rowClash = new Set(d.matches.flatMap((m) => [...clashWith(m)]));
  const shownMatches = d.matches.slice(0, MAX_MATCHES);

  return (
    <div className="border-b px-2 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {d.line}
        </span>
        <div className="min-w-0 flex-1 text-xs">
          <span className="font-medium">{d.form || <em>(no form)</em>}</span>{' '}
          <span className={actionTone(d)}>{actionLabel(d)}</span>
          <span className="text-muted-foreground"> ({d.detail})</span>
        </div>
        <div className="w-32 shrink-0">
          {OVERRIDE_VALUES[d.kind] && (
            <select
              className={cn(
                selectClass,
                'h-7 w-full text-xs',
                override && 'border-foreground/40 font-medium',
              )}
              value={override ?? fallback}
              onChange={(e) => onChoose(e.target.value)}
            >
              {OVERRIDE_VALUES[d.kind].map((v) => (
                <option key={v} value={v}>
                  {ROW_CHOICES[v]}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {columns.length > 0 && (
        <table className="mt-1 w-full table-fixed rounded bg-muted/40 text-xs">
          <thead>
            <tr>
              <th className="w-32" />
              {columns.map((f) => (
                <th key={f} className="px-1 pt-1 text-left font-normal text-muted-foreground">
                  {humanizeFieldName(f)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-2 py-0.5 align-top text-muted-foreground">In this file</td>
              {columns.map((f) => (
                <ValueCell key={f} value={d.values[f]} clash={rowClash.has(f)} add={added.has(f)} />
              ))}
            </tr>
            {shownMatches.map((m, i) => {
              const clash = clashWith(m);
              return (
                <tr key={i}>
                  <td className="px-2 py-0.5 align-top text-muted-foreground">
                    {i === 0 && 'Already here'}
                    {/* The form only earns space when it isn't the row's own,
                        which happens under case-insensitive matching. */}
                    {m.form !== d.form && <div className="text-foreground">{m.form}</div>}
                    {m.pending && <div>(added by this file)</div>}
                  </td>
                  {columns.map((f) => (
                    <ValueCell key={f} value={m.values[f]} clash={clash.has(f)} />
                  ))}
                </tr>
              );
            })}
            {d.matches.length > shownMatches.length && (
              <tr>
                <td className="px-2 py-0.5 text-muted-foreground" colSpan={columns.length + 1}>
                  and {d.matches.length - shownMatches.length} more with this form
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
};
// "Gloss (optional): The short meaning ..."
const LegendEntry = ({ name, note, children }) => (
  <div>
    <dt className="inline font-medium">
      {name} ({note}):
    </dt>{' '}
    <dd className="inline text-muted-foreground">{children}</dd>
  </div>
);

export const BulkAddDialog = ({
  open,
  onOpenChange,
  vocabularyId,
  vocabularyName,
  fields,
  existingItems,
  client,
  onImported,
}) => {
  const fieldNames = useMemo(() => fields.map((f) => f.name), [fields]);
  const fileInputRef = useRef(null);

  const [step, setStep] = useState('source');
  const [pasted, setPasted] = useState('');
  const [file, setFile] = useState(null); // { name, text }
  const [hasHeader, setHasHeader] = useState(false);
  const [mapping, setMapping] = useState([]);
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [strategies, setStrategies] = useState(DEFAULT_STRATEGIES);
  // One row's own answer, keyed by source line, overriding its bucket's.
  const [overrides, setOverrides] = useState({});
  // null until the user picks a view, so the default can follow the plan.
  const [filterChoice, setFilterChoice] = useState(null);
  const [shownRows, setShownRows] = useState(PREVIEW_ROWS);
  const [progress, setProgress] = useState(null); // { done, total, phase }
  const [failure, setFailure] = useState(null); // { message, created, updated }

  const raw = file ? file.text : pasted;
  const { delimiter, rows } = useMemo(() => parseTable(raw), [raw]);

  // Re-guess the shape whenever the source text changes. The user's manual
  // edits to the mapping live on until then.
  useEffect(() => {
    const guess = guessColumns(rows, fieldNames, humanizeFieldName);
    setHasHeader(guess.hasHeader);
    setMapping(guess.mapping);
  }, [raw, rows, fieldNames]);

  const entries = useMemo(
    () => rowsToEntries(rows, mapping, { hasHeader, normalizeValue }),
    [rows, mapping, hasHeader],
  );
  const plan = useMemo(
    () =>
      planVocabImport({
        entries,
        existingItems,
        fieldNames,
        caseInsensitive,
        strategies,
        overrides,
      }),
    [entries, existingItems, fieldNames, caseInsensitive, strategies, overrides],
  );
  const overrideCount = Object.keys(overrides).length;
  // Open on the rows that need a person. When there are none, the useful first
  // view is what the import will actually do.
  const needsDecision = plan.decisions.filter(FILTERS.decide.match).length;
  const filter = filterChoice ?? (needsDecision ? 'decide' : 'changes');
  const setFilter = (key) => {
    setFilterChoice(key);
    setShownRows(PREVIEW_ROWS);
  };

  const rejectedRows = useMemo(() => countRejected(entries), [entries]);
  const formColumns = mapping.filter((m) => m === FORM).length;
  const ignoredColumns = mapping.filter((m) => m === IGNORE).length;
  const columnCount = mapping.length;
  const totalWrites = plan.creates.length + plan.updates.length;

  const reset = () => {
    setStep('source');
    setPasted('');
    setFile(null);
    setCaseInsensitive(false);
    setStrategies(DEFAULT_STRATEGIES);
    setOverrides({});
    setFilterChoice(null);
    setShownRows(PREVIEW_ROWS);
    setProgress(null);
    setFailure(null);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const handleFile = async (picked) => {
    if (!picked) return;
    try {
      setFile({ name: picked.name, text: await picked.text() });
      setPasted('');
    } catch (err) {
      console.error('Could not read the file:', err);
      notifyError('That file could not be read.', 'Import');
    }
  };

  const setColumn = (index, target) =>
    setMapping((prev) => {
      const next = [...prev];
      // The form comes from exactly one column, so claiming it releases the old one.
      if (target === FORM) next.forEach((m, i) => (next[i] = m === FORM ? IGNORE : m));
      next[index] = target;
      return next;
    });

  const downloadReport = () => {
    downloadBlob(
      `${sanitizeFilename(vocabularyName || 'vocabulary')}-import-plan.tsv`,
      new Blob([serializeImportReport(plan.decisions)], {
        type: 'text/tab-separated-values;charset=utf-8',
      }),
    );
  };

  // ---- commit ------------------------------------------------------------
  // Creates go through the uncapped bulk endpoint in chunks, then the updates
  // as batched metadata patches. A chunk that fails leaves the earlier ones in
  // place, which is safe to re-run: the plan is computed against the vocabulary
  // as it stands, so a second pass sees the landed entries as already present.
  const runImport = async () => {
    setStep('running');
    setFailure(null);
    const { creates, updates } = plan;
    const total = creates.length + updates.length;
    let created = 0;
    let updated = 0;
    setProgress({ done: 0, total, phase: creates.length ? 'adding' : 'updating' });
    try {
      await client.withOperation(
        `Bulk add to ${vocabularyName || 'vocabulary'}`,
        async (setMessage) => {
          for (let i = 0; i < creates.length; i += CREATE_CHUNK) {
            const chunk = creates.slice(i, i + CREATE_CHUNK);
            await client.vocabItems.bulkCreate(
              chunk.map((c) => ({
                vocabLayerId: vocabularyId,
                form: c.form,
                ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}),
              })),
            );
            created += chunk.length;
            setProgress({ done: created, total, phase: 'adding' });
          }
          for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
            const chunk = updates.slice(i, i + UPDATE_CHUNK);
            await client.batched(async () => {
              for (const u of chunk) client.vocabItems.patchMetadata(u.id, u.patch);
            });
            updated += chunk.length;
            setProgress({ done: created + updated, total, phase: 'updating' });
          }
          setMessage(
            `Bulk add: ${created} item${created === 1 ? '' : 's'} added, ${updated} updated`,
          );
        },
      );
      await onImported();
      notifySuccess(
        [
          created ? `Added ${n(created)} entr${created === 1 ? 'y' : 'ies'}` : null,
          updated ? `filled in ${n(updated)}` : null,
        ]
          .filter(Boolean)
          .join(', ') || 'Nothing to change',
        'Bulk Add Complete',
      );
      close();
    } catch (err) {
      console.error('Bulk add failed:', err);
      setFailure({ message: err?.message || 'The server rejected the import.', created, updated });
      await onImported();
    }
  };

  // ---- steps -------------------------------------------------------------

  const renderSource = () => (
    <div className="flex flex-col gap-3">
      {file ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
          <span className="text-xs text-muted-foreground">
            {n(rows.length)} row{rows.length === 1 ? '' : 's'} · {delimiterName(delimiter)}
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setFile(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div
          className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 border-dashed p-6 text-center hover:bg-muted/50"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Drop a .tsv or .csv file here, or click to choose</p>
          <p className="text-xs text-muted-foreground">
            Anything a spreadsheet exports: tab-, comma-, or semicolon-separated.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".tsv,.csv,.txt,text/plain,text/csv,text/tab-separated-values"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      )}

      {!file && (
        <>
          <div className="flex items-center gap-2">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or paste</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Textarea
            rows={8}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={`form\t${fieldNames.join('\t')}`}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            One entry per line, columns separated by tabs, so you can paste straight from a
            spreadsheet. The first row may be a header naming the columns, which you confirm next.
            {rows.length > 0 && (
              <>
                {' '}
                <span className="text-foreground">
                  {n(rows.length)} row{rows.length === 1 ? '' : 's'} read.
                </span>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );

  const renderColumns = () => {
    const sampleRows = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + SAMPLE_VALUES);
    const usedFields = mapping.filter((m) => m !== FORM && m !== IGNORE);
    return (
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => setHasHeader(e.target.checked)}
          />
          The first row names the columns (don't import it)
        </label>

        <div className="max-h-64 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            {/* Sticky goes on the cells, not the row: a translucent thead lets
                the first data row show through it as the table scrolls. */}
            <thead className="text-xs text-muted-foreground">
              <tr>
                {['Column', 'First values', 'Import as'].map((h) => (
                  <th
                    key={h}
                    className="sticky top-0 z-10 border-b bg-background px-2 py-1.5 text-left font-medium"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mapping.map((target, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1.5">
                    <span className="text-xs text-muted-foreground">{i + 1}.</span>{' '}
                    {hasHeader ? (
                      <span className="font-medium">{rows[0]?.cells?.[i] || '(blank)'}</span>
                    ) : (
                      <span className="text-muted-foreground">(no header)</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">
                    {sampleRows
                      .map((r) => r.cells[i])
                      .filter((c) => String(c ?? '').trim() !== '')
                      .join(' · ') || <span className="italic">empty</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      className={selectClass}
                      value={target}
                      onChange={(e) => setColumn(i, e.target.value)}
                    >
                      <option value={FORM}>Form (required)</option>
                      {fieldNames.map((f) => (
                        <option key={f} value={f} disabled={target !== f && usedFields.includes(f)}>
                          {humanizeFieldName(f)}
                        </option>
                      ))}
                      <option value={IGNORE}>Don't import</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {formColumns !== 1 && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {formColumns === 0
              ? 'Pick the column holding the entry form before going on.'
              : 'Only one column can be the form.'}
          </p>
        )}

        <div className="rounded-md border bg-muted/30 p-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Legend
          </p>
          <dl className="flex flex-col gap-1.5 text-xs">
            <LegendEntry name="Form" note="required">
              The entry as it appears in the text, which is what a token gets linked to. Repeating a
              form is allowed, since a homonym is a separate entry.
            </LegendEntry>
            {fieldNames.map((f) => (
              <LegendEntry key={f} name={humanizeFieldName(f)} note="optional">
                {fieldDescription(f)}
              </LegendEntry>
            ))}
            {ignoredColumns > 0 && (
              <LegendEntry name="Don't import" note="left out">
                To keep one of these, add a field to this vocabulary on the Fields tab first.
              </LegendEntry>
            )}
          </dl>
        </div>
      </div>
    );
  };

  // A bucket's policy. Row answers that now agree with it are dropped, so the
  // "N row choices" count only ever means rows that differ from their bucket.
  const bucketSelect = (kind) => (
    <select
      className={selectClass}
      value={strategies[kind]}
      onChange={(e) => {
        const value = e.target.value;
        setStrategies((prev) => ({ ...prev, [kind]: value }));
        setOverrides((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== value)),
        );
      }}
    >
      {BUCKET_CHOICES[kind].map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );

  const renderReview = () => {
    const { counts } = plan;
    const rows = plan.decisions.filter(FILTERS[filter].match);
    const visible = rows.slice(0, shownRows);
    // Columns are shared by every row on screen, so the same field sits in the
    // same place all the way down. Fields nobody on screen uses are left out.
    const has = (values, f) => String(values?.[f] ?? '').trim() !== '';
    const columns = fieldNames.filter((f) =>
      visible.some((d) => has(d.values, f) || d.matches.some((m) => has(m.values, f))),
    );
    return (
      <div className="flex flex-col gap-3">
        {/* The rows come first: the decisions are the thing being reviewed, and
            the bucket levers below are what you reach for once you have seen
            what they are doing. */}
        <div className="rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1.5">
            <select
              className={selectClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {Object.entries(FILTERS).map(([key, f]) => (
                <option key={key} value={key}>
                  {f.label} ({n(plan.decisions.filter(f.match).length)})
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              {overrideCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setOverrides({})}
                >
                  Clear {n(overrideCount)} row choice{overrideCount === 1 ? '' : 's'}
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={downloadReport}>
                <Download className="h-3 w-3" /> Full plan (.tsv)
              </Button>
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No rows here.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {visible.map((d) => (
                <DecisionRow
                  key={d.line}
                  d={d}
                  columns={columns}
                  override={overrides[d.line]}
                  fallback={strategies[d.kind]}
                  onChoose={(value) =>
                    setOverrides((prev) => {
                      const next = { ...prev };
                      // Falling back to the bucket's answer is the same as
                      // having no answer of your own.
                      if (value === strategies[d.kind]) delete next[d.line];
                      else next[d.line] = value;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}

          {rows.length > visible.length && (
            <button
              type="button"
              className="w-full border-t py-1.5 text-xs text-muted-foreground hover:bg-muted/50"
              onClick={() => setShownRows((v) => v + PREVIEW_ROWS)}
            >
              Showing {n(visible.length)} of {n(rows.length)}. Show more
            </button>
          )}
        </div>

        {rejectedRows > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {n(rejectedRows)} row{rejectedRows === 1 ? ' has a' : 's have an'} unrecognized Morph
            Type. That value is left out and the rest of the row still imports.
          </p>
        )}

        <div className="rounded-md border px-3 py-1">
          <Bucket tone="good" count={counts.new} label="new entries will be added" />
          <Bucket
            tone="muted"
            count={counts.identical}
            label="rows are already in the vocabulary, with nothing to add, so they are skipped"
          />
          <Bucket
            tone="good"
            count={counts.enrich}
            label="rows fill in blanks on an entry that's already here"
          >
            {bucketSelect('enrich')}
          </Bucket>
          <Bucket
            tone="warn"
            count={counts.conflict}
            label="rows disagree with an entry that has the same form, often a second sense and sometimes a correction"
          >
            {bucketSelect('conflict')}
          </Bucket>
          <Bucket
            tone="warn"
            count={counts.ambiguous}
            label="rows could belong to more than one entry sharing that form"
          >
            {bucketSelect('ambiguous')}
          </Bucket>
          <Bucket
            tone="muted"
            count={counts.blank}
            label="rows have no form, so they are skipped"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={caseInsensitive}
            onChange={(e) => setCaseInsensitive(e.target.checked)}
          />
          Match forms ignoring capitalization
        </label>
      </div>
    );
  };

  const renderRunning = () =>
    failure ? (
      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {failure.message}
        </p>
        <p className="text-sm text-muted-foreground">
          {n(failure.created)} added and {n(failure.updated)} updated before it stopped. Running the
          same import again is safe, because what already landed will show up as already present.
        </p>
      </div>
    ) : (
      <div className="flex items-center justify-center gap-3 py-8">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">
          {progress?.phase === 'updating' ? 'Filling in entries' : 'Adding entries'}:{' '}
          {n(progress?.done ?? 0)} of {n(progress?.total ?? 0)}
        </p>
      </div>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && step !== 'running') close();
      }}
    >
      {/* The review step carries a column per field and earns the extra width. */}
      <DialogContent className={step === 'review' ? 'max-w-4xl' : 'max-w-2xl'}>
        <DialogHeader>
          <DialogTitle>
            {step === 'running' ? (failure ? 'Import Stopped' : 'Importing') : STEPS[step].title}
            {STEPS[step] && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Step {STEPS[step].n} of {WIZARD_STEPS}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {step === 'source' && renderSource()}
        {step === 'columns' && renderColumns()}
        {step === 'review' && renderReview()}
        {step === 'running' && renderRunning()}

        <DialogFooter>
          {step === 'source' && (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!rows.length} onClick={() => setStep('columns')}>
                Next: columns
              </Button>
            </>
          )}
          {step === 'columns' && (
            <>
              <Button variant="outline" onClick={() => setStep('source')}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button
                disabled={formColumns !== 1 || !columnCount}
                onClick={() => setStep('review')}
              >
                Next: review
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button variant="outline" onClick={() => setStep('columns')}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button disabled={!totalWrites} onClick={runImport}>
                {totalWrites
                  ? [
                      plan.creates.length ? `Add ${n(plan.creates.length)}` : null,
                      plan.updates.length ? `update ${n(plan.updates.length)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : 'Nothing to import'}
              </Button>
            </>
          )}
          {step === 'running' && failure && (
            <Button variant="outline" onClick={close}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
