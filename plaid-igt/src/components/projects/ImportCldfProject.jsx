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
  FinishPending,
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
import { t, tx, msg } from '@ui/lib/i18n.js';

import { documentFraction, documentLabel } from '../../import/progress';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';

const SCOPES = ['Sentence', 'Word', 'Morpheme', 'Orthography'];
// The scopes' names on screen.
const SCOPE_LABELS = {
  Sentence: msg('Sentence'),
  Word: msg('Word'),
  Morpheme: msg('Morpheme'),
  Orthography: msg('Orthography'),
};
const OFF = '__off__';

export const ImportCldfProject = () => {
  useDocumentTitle(t('Import CLDF'));
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
    finishPending,
    retryFinish,
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
      notifyError(humanizeError(e), t('Failed to read the dataset'));
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
                label: t('Importing lexicon ({done}/{total})', { done: p.done, total: p.total }),
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
        <ImportHeader title={t('Import a CLDF dataset')}>
          {tx(
            'Create a project from a <a>Cross-Linguistic Data Formats</a> dataset: its examples become interlinear texts, its lexicon becomes a vocabulary, and its language becomes the project’s identity.',
            {
              a: (c) => (
                <a
                  href="https://cldf.clld.org"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {c}
                </a>
              ),
            },
          )}
        </ImportHeader>

        {stage === 'pick' && (
          <FileDropZone
            onFiles={(files) => handleFile(files?.[0])}
            title={t('Drop a CLDF .zip here, or click to choose')}
            hint={t(
              'Any dataset with an ExampleTable: a TextCorpus, or a Dictionary with examples',
            )}
            accept=".zip,application/zip"
          />
        )}

        {stage === 'parsing' && <ReadingPanel label={t('Reading dataset…')} />}

        {stage !== 'pick' && stage !== 'parsing' && build && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                {dataset.title || t('Dataset')}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {dataset.module}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>
                  {t('{n, plural, one {# text} other {# texts}}', { n: build.stats.documents })}
                </p>
                <p>
                  {t('{n, plural, one {# sentence} other {# sentences}}', {
                    n: build.stats.sentences,
                  })}
                </p>
                <p>{t('{n, plural, one {# word} other {# words}}', { n: build.stats.words })}</p>
                <p>
                  {t('{n, plural, one {# morpheme} other {# morphemes}}', {
                    n: build.stats.morphemes,
                  })}
                </p>
                <p>
                  {t('{n, plural, one {# lexicon entry} other {# lexicon entries}}', {
                    n: build.stats.lexiconEntries,
                  })}
                </p>
                <p>
                  {t('{n, plural, one {# annotation field} other {# annotation fields}}', {
                    n: build.schema.fields.length,
                  })}
                </p>
              </div>
              {build.schema.fields.length > 0 && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  {t('Fields: {fields}', {
                    fields: build.schema.fields
                      .map((f) =>
                        t(
                          '{name} ({scope, select, Sentence {Sentence} Word {Word} Morpheme {Morpheme} Orthography {Orthography} other {{scope}}})',
                          { name: f.name, scope: f.scope },
                        ),
                      )
                      .join(', '),
                  })}
                </p>
              )}
              {build.lexicon.length > 0 && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  {t('Each entry keeps its senses.')}
                </p>
              )}
              {build.languages.object && (
                <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  {build.languages.object.glottocode
                    ? tx('Object language: <strong>{name}</strong> ({glottocode})', {
                        name: build.languages.object.name || t('unnamed'),
                        glottocode: build.languages.object.glottocode,
                        strong: (c) => <strong>{c}</strong>,
                      })
                    : tx('Object language: <strong>{name}</strong>', {
                        name: build.languages.object.name || t('unnamed'),
                        strong: (c) => <strong>{c}</strong>,
                      })}
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
                <p className="text-sm font-medium">{t('How the gloss is read')}</p>
                <p className="text-xs text-muted-foreground">
                  {tx(
                    'Morpheme scope splits each analyzed word on <code>-</code> and <code>=</code> and aligns the gloss piece by piece. Word scope keeps the gloss whole.',
                    { code: (c) => <code>{c}</code> },
                  )}
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
                  <SelectItem value="Morpheme">{t('Morpheme (segmented)')}</SelectItem>
                  <SelectItem value="Word">{t('Word (whole)')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {groupChoices.length > 0 && (
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div>
                  <p className="text-sm font-medium">{t('How the examples split into texts')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('Only “One document per example” keeps each example’s own audio.')}
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
                  <p className="text-sm font-medium">{t('Columns CLDF has no term for')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'Choose where each goes. A Word or Morpheme field needs one value per word.',
                    )}
                  </p>
                </div>
                {columnChoices
                  .filter((choice) => choice.name !== options.groupBy)
                  .map((choice) => {
                    const mapping = options.customColumns[choice.name];
                    const active = mapping && mapping.enabled !== false;
                    return (
                      <div key={choice.name} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm">{choice.label}</span>
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
                                  {t(SCOPE_LABELS[s])}
                                </SelectItem>
                              ),
                            )}
                            <SelectItem value={OFF}>{t('Don’t import')}</SelectItem>
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
                        {t('A dictionary without examples cannot be imported')}
                      </p>
                      <p className="text-xs">
                        {t(
                          'This dataset has {n, plural, one {# entry} other {# entries}} but no ExampleTable, so it has no texts.',
                          { n: build.lexicon.length },
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium">{t('Nothing to import')}</p>
                      <p className="text-xs">{t('No examples were found in this dataset.')}</p>
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
                {t(
                  '{n, plural, one {# analyzed word} other {# analyzed words}} could not be located in the primary text and will be skipped. The full list is in the import warnings.',
                  { n: build.stats.unalignedWords },
                )}
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

            {stage === 'done' && finishPending && <FinishPending onRetry={retryFinish} />}

            {stage === 'done' && results && (
              <Notice tone="success" className="p-4">
                <p className="font-medium">
                  {t('Imported {n, plural, one {# text} other {# texts}}', { n: results.imported })}
                </p>
                {results.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {results.warnings.slice(0, 8).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {results.warnings.length > 8 && (
                      <li>{t('…and {n} more', { n: results.warnings.length - 8 })}</li>
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
                  {t('Create project and import')}
                </Button>
              )}
              {stage === 'done' && !finishPending && (
                <Button asChild>
                  <Link to={`/projects/${projectIdRef.current}`}>{t('Open project')}</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
