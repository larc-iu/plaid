// "Import CLDF" — create a project from a CLDF dataset (https://cldf.clld.org).
// Flow: pick file → read + build client-side → review (name, contents, how the
// gloss is scoped, what to do with columns CLDF has no term for) → run (shared
// project setup, then the CLDF import engine) → done.
//
// Resume mirrors the other import pages: the created project id and setup
// completion live in refs for this page session, so Retry re-runs against the
// same project; the engine skips documents already marked done, redoes
// half-imported ones, and dedupes lexicon items by their stamped entry id.

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Check, RefreshCw, Square, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/feedback';
import { readCldfDataset } from '../../import/cldf/readDataset';
import {
  buildCldfDocuments,
  deriveImportOptions,
  customColumnChoices,
  groupingChoices,
} from '../../import/cldf/buildDocuments';
import { deriveSetupData, runCldfImport } from '../../import/cldf/importEngine';
import { executeProjectSetup } from './setup/executeSetup';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const SCOPES = ['Sentence', 'Word', 'Morpheme', 'Orthography'];
const OFF = '__off__';

export const ImportCldfProject = () => {
  useDocumentTitle('Import CLDF');
  const { client } = useAuth();
  const fileInputRef = useRef(null);

  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [dataset, setDataset] = useState(null);
  const [options, setOptions] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [progress, setProgress] = useState(null);
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);

  const projectIdRef = useRef(null);
  const setupDoneRef = useRef(false);
  const stopRef = useRef(false);

  // The build is re-derived whenever an option changes, so the review numbers
  // and warnings always describe what the import would actually do.
  const build = useMemo(
    () => (dataset && options ? buildCldfDocuments(dataset, options) : null),
    [dataset, options],
  );
  const columnChoices = useMemo(() => (dataset ? customColumnChoices(dataset) : []), [dataset]);
  const groupChoices = useMemo(() => (dataset ? groupingChoices(dataset) : []), [dataset]);

  const handleFile = async (file) => {
    if (!file) return;
    setStage('parsing');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = readCldfDataset(bytes);
      setDataset(parsed);
      setOptions(deriveImportOptions(parsed));
      setProjectName(parsed.title || file.name.replace(/\.zip$/i, ''));
      setStage('review');
    } catch (e) {
      console.error('CLDF read failed:', e);
      notifyError(e.message, 'Could not read dataset');
      setStage('pick');
    }
  };

  const setColumn = (column, mapping) =>
    setOptions((o) => ({ ...o, customColumns: { ...o.customColumns, [column]: mapping } }));

  const startImport = async () => {
    setStage('running');
    setRunError(null);
    stopRef.current = false;
    try {
      if (!setupDoneRef.current) {
        const setup = await executeProjectSetup({
          client,
          isNewProject: true,
          resumeProjectId: projectIdRef.current,
          setupData: deriveSetupData(build, projectName.trim()),
          onProgress: (pct, msg) => setProgress({ label: msg, pct: pct * 0.15 }),
          onProjectCreated: (id) => {
            projectIdRef.current = id;
          },
        });
        if (setup.failures.length > 0) throw new Error(setup.failures.join('. '));
        projectIdRef.current = setup.projectId;
        setupDoneRef.current = true;
      }

      const res = await runCldfImport({
        client,
        projectId: projectIdRef.current,
        build,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          if (p.phase === 'lexicon') {
            setProgress({
              label: `Importing lexicon (${p.done}/${p.total})`,
              pct: 15 + (p.total ? (p.done / p.total) * 15 : 15),
            });
          } else if (p.phase === 'document') {
            const n = (p.index ?? 0) + 1;
            const total = p.total ?? build.documents.length;
            setProgress({
              label: `${p.doc}${p.step ? `: ${p.step}` : ''} (${n}/${total})`,
              pct: 30 + (n / total) * 70,
            });
          }
        },
      });
      setResults(res);
      setStage('done');
      if (res.warnings.length) {
        notifyWarning(
          `Imported with ${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}.`,
          'Import finished',
        );
      } else {
        notifySuccess(
          `Imported ${res.imported} document${res.imported === 1 ? '' : 's'}.`,
          'Import complete',
        );
      }
    } catch (e) {
      console.error('CLDF import failed:', e);
      setRunError(e.message);
      setStage('review');
      if (!/cancelled/i.test(e.message)) notifyError(e.message, 'Import failed');
    }
  };

  const editable = stage === 'review';

  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
          <span>/</span>
          <Link to="/projects/new" className="hover:text-foreground hover:underline">
            New Project
          </Link>
          <span>/</span>
          <span>Import CLDF</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Import a CLDF dataset</h1>
          <p className="text-sm text-muted-foreground">
            Create a project from a{' '}
            <a
              href="https://cldf.clld.org"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Cross-Linguistic Data Formats
            </a>{' '}
            dataset: its examples become interlinear texts, its lexicon becomes a vocabulary, and
            its language becomes the project’s identity.
          </p>
        </div>

        {stage === 'pick' && (
          <div
            className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-12 text-center hover:bg-muted/50"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Drop a CLDF .zip here, or click to choose</p>
            <p className="text-sm text-muted-foreground">
              Any dataset with an ExampleTable: a TextCorpus, or a Dictionary with examples
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        {stage === 'parsing' && (
          <div className="flex items-center justify-center gap-3 rounded-lg border bg-card p-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            <p className="text-sm text-muted-foreground">Reading dataset…</p>
          </div>
        )}

        {stage !== 'pick' && stage !== 'parsing' && build && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                {dataset.title || 'Dataset'}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {dataset.module}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>{build.stats.documents} texts</p>
                <p>{build.stats.sentences.toLocaleString()} sentences</p>
                <p>{build.stats.words.toLocaleString()} words</p>
                <p>{build.stats.morphemes.toLocaleString()} morphemes</p>
                <p>{build.stats.lexiconEntries.toLocaleString()} lexicon entries</p>
                <p>{build.schema.fields.length} annotation fields</p>
              </div>
              {build.languages.object && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Object language: <strong>{build.languages.object.name || 'unnamed'}</strong>
                  {build.languages.object.glottocode
                    ? ` (${build.languages.object.glottocode})`
                    : ''}
                </p>
              )}
            </div>

            <div className="rounded-lg border bg-card p-4">
              <Label className="mb-1 block text-sm font-medium" htmlFor="cldf-project-name">
                Project name
              </Label>
              <Input
                id="cldf-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                disabled={!editable || setupDoneRef.current}
              />
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div>
                <p className="text-sm font-medium">How the gloss is read</p>
                <p className="text-xs text-muted-foreground">
                  Morpheme scope splits each analyzed word on <code>-</code> and <code>=</code> and
                  aligns the gloss piece by piece. Word scope keeps the gloss whole.
                </p>
              </div>
              <Select
                value={options.glossScope}
                onValueChange={(v) => setOptions((o) => ({ ...o, glossScope: v }))}
                disabled={!editable}
              >
                <SelectTrigger className="h-8 w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Morpheme">Morpheme (segmented)</SelectItem>
                  <SelectItem value="Word">Word (whole)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {groupChoices.length > 0 && (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div>
                  <p className="text-sm font-medium">How the examples split into texts</p>
                  <p className="text-xs text-muted-foreground">
                    This dataset has no ContributionTable, so the texts are told apart by one of its
                    own columns. Without a split, every example lands in a single document.
                  </p>
                </div>
                <Select
                  value={options.groupBy ?? OFF}
                  onValueChange={(v) =>
                    setOptions((o) => ({ ...o, groupBy: v === OFF ? null : v }))
                  }
                  disabled={!editable}
                >
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groupChoices.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                    <SelectItem value={OFF}>One text for everything</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {columnChoices.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
                <div>
                  <p className="text-sm font-medium">Columns CLDF has no term for</p>
                  <p className="text-xs text-muted-foreground">
                    These carry no ontology binding, so where they belong is a judgement call.
                    Per-word scopes need a column whose values are one list per word.
                  </p>
                </div>
                {columnChoices
                  .filter((choice) => choice.name !== options.groupBy)
                  .map((choice) => {
                    const mapping = options.customColumns[choice.name];
                    const active = mapping && mapping.enabled !== false;
                    return (
                      <div key={choice.name} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm">{choice.name}</span>
                        <Select
                          value={active ? mapping.scope : OFF}
                          disabled={!editable}
                          onValueChange={(v) =>
                            setColumn(
                              choice.name,
                              v === OFF
                                ? { ...mapping, enabled: false }
                                : { scope: v, name: mapping?.name || choice.name, enabled: true },
                            )
                          }
                        >
                          <SelectTrigger className="h-8 w-40 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SCOPES.filter((s) => choice.canBePerWord || s === 'Sentence').map(
                              (s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ),
                            )}
                            <SelectItem value={OFF}>Don’t import</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          className="h-8 w-40 shrink-0"
                          value={mapping?.name ?? choice.name}
                          disabled={!editable || !active}
                          onChange={(e) =>
                            setColumn(choice.name, { ...mapping, name: e.target.value })
                          }
                        />
                      </div>
                    );
                  })}
              </div>
            )}

            {build.documents.length === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  {build.lexicon.length > 0 ? (
                    <>
                      <p className="font-medium">
                        Importing a dictionary on its own is not yet implemented
                      </p>
                      <p className="text-xs text-muted-foreground">
                        This dataset has {build.lexicon.length.toLocaleString()} entries but no
                        ExampleTable, so there are no texts to build a project around. Bringing a
                        CLDF dictionary in as a standalone vocabulary is still to do.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium">Nothing to import</p>
                      <p className="text-xs text-muted-foreground">
                        No examples were found in this dataset.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {build.warnings.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {build.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {build.stats.unalignedWords > 0 && (
              <p className="text-xs text-muted-foreground">
                {build.stats.unalignedWords} analyzed word
                {build.stats.unalignedWords === 1 ? '' : 's'} could not be located in the primary
                text and will be skipped. The full list is in the import warnings.
              </p>
            )}

            {runError && editable && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {/cancelled/i.test(runError)
                  ? 'Import stopped. Retry continues where it left off.'
                  : `Import failed: ${runError}. Retry continues where it left off.`}
              </div>
            )}

            {stage === 'running' && (
              <div className="rounded-lg border bg-card p-4">
                <div className="mb-2 h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progress?.pct ?? 0}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{progress?.label ?? 'Starting…'}</p>
              </div>
            )}

            {stage === 'done' && results && (
              <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                <p className="flex items-center gap-2 font-medium">
                  <Check className="h-4 w-4" /> Imported {results.imported} text
                  {results.imported === 1 ? '' : 's'}
                  {results.skipped ? ` (${results.skipped} already done)` : ''}
                  {results.redone ? ` (${results.redone} redone)` : ''}
                </p>
                {results.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {results.warnings.slice(0, 8).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {results.warnings.length > 8 && (
                      <li>…and {results.warnings.length - 8} more</li>
                    )}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {editable && (
                <Button
                  onClick={startImport}
                  disabled={!projectName.trim() || !build.documents.length}
                >
                  {runError ? (
                    <>
                      <RefreshCw className="h-4 w-4" /> Retry import
                    </>
                  ) : (
                    'Create project & import'
                  )}
                </Button>
              )}
              {stage === 'running' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    stopRef.current = true;
                  }}
                >
                  <Square className="h-4 w-4" /> Stop
                </Button>
              )}
              {stage === 'done' && (
                <Button asChild>
                  <Link to={`/projects/${projectIdRef.current}`}>Open project</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
