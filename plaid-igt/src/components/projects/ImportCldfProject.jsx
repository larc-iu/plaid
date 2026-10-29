// "Import CLDF" — create a project from a CLDF dataset (https://cldf.clld.org).
// Flow: pick file → read + build client-side → review (name, contents, how the
// gloss is scoped, what to do with columns CLDF has no term for) → run (shared
// project setup, then the CLDF import engine) → done. A run that stops leaves
// a project that is only deleted (useProjectImportRun).

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Notice } from '@ui/components/shared/Notice.jsx';
import {
  FileDropZone,
  ImportHeader,
  ImportRunPanel,
  ProjectNameField,
  ReadingPanel,
} from './ImportPanels';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import { useAuth } from '../../contexts/AuthContext';
import { useClientApart } from '@/hooks/useClientApart';
import { notifyError, humanizeError } from '@/utils/feedback';
import { readCldfDataset } from '../../import/cldf/readDataset';
import {
  buildCldfDocuments,
  deriveImportOptions,
  customColumnChoices,
  groupingChoices,
  SINGLE_TEXT,
} from '../../import/cldf/buildDocuments';
import { deriveSetupData, runCldfImport } from '../../import/cldf/importEngine';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';
import { countOf } from '@ui/lib/plural.js';

import { documentFraction, documentLabel } from '../../import/progress';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';

const SCOPES = ['Sentence', 'Word', 'Morpheme', 'Orthography'];
const OFF = '__off__';

export const ImportCldfProject = () => {
  useDocumentTitle('Import CLDF');
  const { client: session } = useAuth();
  // The run's own client, so a write made elsewhere in the tab meanwhile is
  // neither stamped with its document version nor filed under its operation.
  const client = useClientApart(session);
  const [dataset, setDataset] = useState(null);
  const [options, setOptions] = useState(null);
  const [projectName, setProjectName] = useState('');

  const {
    stage,
    setStage,
    progress,
    runError,
    stopped,
    results,
    projectIdRef,
    unfinished,
    clearUnfinished,
    stop,
    start,
  } = useProjectImportRun({ client, kind: 'CLDF' });

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
      notifyError(humanizeError(e), 'Failed to read the dataset');
      setStage('pick');
    }
  };

  const setColumn = (column, mapping) =>
    setOptions((o) => ({ ...o, customColumns: { ...o.customColumns, [column]: mapping } }));

  const startImport = () =>
    start({
      source: dataset?.title ?? null,
      setupData: () => deriveSetupData(build, projectName.trim()),
      run: ({ projectId, shouldStop, setProgress }) =>
        runCldfImport({
          client,
          projectId,
          build,
          shouldStop,
          onProgress: (p) => {
            if (p.phase === 'lexicon') {
              setProgress({
                label: `Importing lexicon (${p.done}/${p.total})`,
                pct: 15 + (p.total ? (p.done / p.total) * 15 : 15),
              });
            } else if (p.phase === 'document') {
              setProgress({
                label: documentLabel(p, build.documents.length),
                pct: 30 + documentFraction(p, build.documents.length) * 70,
              });
            }
          },
        }),
    });

  const editable = stage === 'review';
  // The answers lock while a stopped run's project is still there.
  const locked = !editable || !!unfinished;

  return (
    <div className={FORM_PAGE_WIDTH}>
      <div className="flex flex-col gap-6">
        <ImportHeader title="Import a CLDF dataset">
          Create a project from a{' '}
          <a
            href="https://cldf.clld.org"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Cross-Linguistic Data Formats
          </a>{' '}
          dataset: its examples become interlinear texts, its lexicon becomes a vocabulary, and its
          language becomes the project’s identity.
        </ImportHeader>

        {stage === 'pick' && (
          <FileDropZone
            onFiles={(files) => handleFile(files?.[0])}
            title="Drop a CLDF .zip here, or click to choose"
            hint="Any dataset with an ExampleTable: a TextCorpus, or a Dictionary with examples"
            accept=".zip,application/zip"
          />
        )}

        {stage === 'parsing' && <ReadingPanel label="Reading dataset…" />}

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
                <p>{countOf(build.stats.documents, 'text')}</p>
                <p>{countOf(build.stats.sentences, 'sentence')}</p>
                <p>{countOf(build.stats.words, 'word')}</p>
                <p>{countOf(build.stats.morphemes, 'morpheme')}</p>
                <p>{countOf(build.stats.lexiconEntries, 'lexicon entry', 'lexicon entries')}</p>
                <p>{countOf(build.schema.fields.length, 'annotation field')}</p>
              </div>
              {build.schema.fields.length > 0 && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Fields: {build.schema.fields.map((f) => `${f.name} (${f.scope})`).join(', ')}
                </p>
              )}
              {build.lexicon.length > 0 && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Each entry keeps its senses.
                </p>
              )}
              {build.languages.object && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Object language: <strong>{build.languages.object.name || 'unnamed'}</strong>
                  {build.languages.object.glottocode
                    ? ` (${build.languages.object.glottocode})`
                    : ''}
                </p>
              )}
            </div>

            <ProjectNameField
              id="cldf-project-name"
              value={projectName}
              onChange={setProjectName}
              disabled={locked}
            />

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
                disabled={locked}
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
                    Only “One document per example” keeps each example’s own audio.
                  </p>
                </div>
                <Select
                  value={options.groupBy ?? SINGLE_TEXT}
                  onValueChange={(v) => setOptions((o) => ({ ...o, groupBy: v }))}
                  disabled={locked}
                >
                  <SelectTrigger className="h-8 w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groupChoices.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {columnChoices.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
                <div>
                  <p className="text-sm font-medium">Columns CLDF has no term for</p>
                  <p className="text-xs text-muted-foreground">
                    Choose where each goes. A Word or Morpheme field needs one value per word.
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
                          disabled={locked}
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
                          disabled={locked || !active}
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
              <Notice tone="warning" className="p-3">
                <div>
                  {build.lexicon.length > 0 ? (
                    <>
                      <p className="font-medium">
                        A dictionary without examples cannot be imported
                      </p>
                      <p className="text-xs">
                        This dataset has {countOf(build.lexicon.length, 'entry', 'entries')} but no
                        ExampleTable, so it has no texts.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium">Nothing to import</p>
                      <p className="text-xs">No examples were found in this dataset.</p>
                    </>
                  )}
                </div>
              </Notice>
            )}

            {build.warnings.length > 0 && (
              <Notice tone="warning" className="p-3">
                <ul className="flex list-disc flex-col gap-1 ps-4">
                  {build.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}

            {build.stats.unalignedWords > 0 && (
              <p className="text-xs text-muted-foreground">
                {countOf(build.stats.unalignedWords, 'analyzed word')} could not be located in the
                primary text and will be skipped. The full list is in the import warnings.
              </p>
            )}

            <ImportRunPanel
              stage={stage}
              runError={runError}
              stopped={stopped}
              unfinished={unfinished}
              client={client}
              onDeleted={clearUnfinished}
              progress={progress}
              onStop={stop}
            />

            {stage === 'done' && results && (
              <Notice tone="success" className="p-4">
                <p className="font-medium">Imported {countOf(results.imported, 'text')}</p>
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
              </Notice>
            )}

            <div className="flex justify-end gap-2">
              {editable && !unfinished && (
                <Button
                  onClick={startImport}
                  disabled={!projectName.trim() || !build.documents.length}
                >
                  Create project and import
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
