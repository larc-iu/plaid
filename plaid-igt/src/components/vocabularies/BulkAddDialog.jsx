// Bulk add: paste or upload a table of entries, say what its columns hold, and
// review how it merges with what the vocabulary already has before committing.
//
// Three steps, because the realistic import is a few thousand rows from a
// dictionary kept in another tool against a vocabulary already built from
// texts: nobody can eyeball that, so the merge has to be planned, summarized,
// and reviewable (see import/vocabBulk.js for the merge rules) before a single
// write goes out.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileText, X, ArrowLeft, Download, AlertTriangle } from 'lucide-react';
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

const PREVIEW_ROWS = 12;
const SAMPLE_VALUES = 3;

const selectClass =
  'h-8 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60';

const n = (x) => x.toLocaleString();

// Morph types are a controlled vocabulary; accept any casing an external
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
  const [progress, setProgress] = useState(null); // { done, total, phase }
  const [failure, setFailure] = useState(null); // { message, created, updated }

  const raw = file ? file.text : pasted;
  const { delimiter, rows } = useMemo(() => parseTable(raw), [raw]);

  // Re-guess the shape whenever the source text changes; the user's manual
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
    () => planVocabImport({ entries, existingItems, fieldNames, caseInsensitive, strategies }),
    [entries, existingItems, fieldNames, caseInsensitive, strategies],
  );

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
      // The form comes from exactly one column; claiming it releases the old one.
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
            One entry per line, columns separated by tabs — paste straight from a spreadsheet. The
            first row may be a header naming the columns; you'll confirm that next.
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
            <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Column</th>
                <th className="px-2 py-1.5 text-left font-medium">First values</th>
                <th className="px-2 py-1.5 text-left font-medium">Import as</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((target, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1.5">
                    <span className="text-xs text-muted-foreground">{i + 1}.</span>{' '}
                    {hasHeader ? (
                      <span className="font-medium">{rows[0]?.cells?.[i] || '—'}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
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
            What the columns mean
          </p>
          <dl className="flex flex-col gap-1.5 text-xs">
            <div>
              <dt className="inline font-medium">Form</dt>
              <dd className="inline text-muted-foreground">
                {' '}
                — required. The entry as it appears in the text; it's what a token gets linked to.
                Repeating a form is allowed (a homonym is a separate entry).
              </dd>
            </div>
            {fieldNames.map((f) => (
              <div key={f}>
                <dt className="inline font-medium">{humanizeFieldName(f)}</dt>
                <dd className="inline text-muted-foreground"> — optional. {fieldDescription(f)}</dd>
              </div>
            ))}
            {ignoredColumns > 0 && (
              <div>
                <dt className="inline font-medium">Don't import</dt>
                <dd className="inline text-muted-foreground">
                  {' '}
                  — the column is left out. To keep one of these, add a field to this vocabulary on
                  the Fields tab first.
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    );
  };

  const renderReview = () => {
    const { counts } = plan;
    const shown = plan.decisions.filter((d) => d.action !== 'skip').slice(0, PREVIEW_ROWS);
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-md border px-3 py-1">
          <Bucket tone="good" count={counts.new} label="new entries will be added" />
          <Bucket
            tone="muted"
            count={counts.identical}
            label="rows are already in the vocabulary, with nothing to add — skipped"
          />
          <Bucket
            tone="good"
            count={counts.enrich}
            label="rows fill in blanks on an entry that's already here"
          >
            <select
              className={selectClass}
              value={strategies.enrich}
              onChange={(e) => setStrategies((s) => ({ ...s, enrich: e.target.value }))}
            >
              <option value={ENRICH_FILL}>Fill in the blank fields</option>
              <option value={ENRICH_SKIP}>Leave the existing entry alone</option>
            </select>
          </Bucket>
          <Bucket
            tone="warn"
            count={counts.conflict}
            label="rows disagree with an entry that has the same form — often a second sense, sometimes a correction"
          >
            <select
              className={selectClass}
              value={strategies.conflict}
              onChange={(e) => setStrategies((s) => ({ ...s, conflict: e.target.value }))}
            >
              <option value={CONFLICT_SKIP}>Skip them, keep what's here</option>
              <option value={CONFLICT_NEW}>Add each as a separate entry</option>
              <option value={CONFLICT_OVERWRITE}>Replace the existing values</option>
            </select>
          </Bucket>
          <Bucket
            tone="warn"
            count={counts.ambiguous}
            label="rows could belong to more than one entry sharing that form"
          >
            <select
              className={selectClass}
              value={strategies.ambiguous}
              onChange={(e) => setStrategies((s) => ({ ...s, ambiguous: e.target.value }))}
            >
              <option value={AMBIGUOUS_SKIP}>Skip them</option>
              <option value={AMBIGUOUS_NEW}>Add each as a separate entry</option>
            </select>
          </Bucket>
          <Bucket tone="muted" count={counts.blank} label="rows have no form — skipped" />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={caseInsensitive}
            onChange={(e) => setCaseInsensitive(e.target.checked)}
          />
          Match forms ignoring capitalization
        </label>

        {rejectedRows > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {n(rejectedRows)} row{rejectedRows === 1 ? ' has a' : 's have an'} unrecognized Morph
            Type; that value is left out and the rest of the row still imports.
          </p>
        )}

        {shown.length > 0 && (
          <div className="rounded-md border">
            <div className="flex items-center justify-between border-b px-2 py-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                First changes
              </p>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={downloadReport}>
                <Download className="h-3 w-3" /> Full plan (.tsv)
              </Button>
            </div>
            <div className="max-h-44 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {shown.map((d, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="w-10 px-2 py-1 text-right tabular-nums text-muted-foreground">
                        {d.line}
                      </td>
                      <td className="px-2 py-1 font-medium">{d.form}</td>
                      <td className="px-2 py-1 text-muted-foreground">{d.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
          same import again is safe — what already landed will show up as already present.
        </p>
      </div>
    ) : (
      <div className="flex items-center justify-center gap-3 py-8">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        <p className="text-sm text-muted-foreground">
          {progress?.phase === 'updating' ? 'Filling in entries' : 'Adding entries'} —{' '}
          {n(progress?.done ?? 0)} of {n(progress?.total ?? 0)}
        </p>
      </div>
    );

  const TITLES = {
    source: 'Bulk Add — paste or upload',
    columns: 'Bulk Add — what the columns hold',
    review: 'Bulk Add — review the merge',
    running: failure ? 'Bulk Add — stopped' : 'Bulk Add — importing',
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && step !== 'running') close();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{TITLES[step]}</DialogTitle>
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
