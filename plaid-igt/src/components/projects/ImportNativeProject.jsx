// "Import archive" — recreate a project from a Plaid IGT JSON export
// (docs/native-format.md). Flow: pick file → read + validate client-side →
// review (project name, archive contents) → run (shared project setup, then
// the native import engine) → done. A run that stops leaves a project that is
// only deleted (useProjectImportRun).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import {
  FileDropZone,
  FinishPending,
  ImportHeader,
  ImportRunPanel,
  ProjectNameField,
  ReadingPanel,
} from './ImportPanels';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { useAuth } from '../../contexts/AuthContext';
import { useClientApart } from '@/hooks/useClientApart';
import { notifyError, humanizeError } from '@/utils/feedback';
import { readNativeArchive } from '../../import/native/readArchive';
import { deriveSetupData, runNativeImport } from '../../import/native/importEngine';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';
import { t } from '@ui/lib/i18n.js';

import { documentFraction, documentLabel } from '../../import/progress';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { NATIVE_IMPORT_KIND } from '@/domain/importFinish';

// When the archive was exported, and the past state it holds if it holds one.
const exportedLine = (manifest) => {
  const when = manifest.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : null;
  const asOf = manifest.asOf ? new Date(manifest.asOf).toLocaleString() : null;
  if (when && asOf) return t('exported {when} (as of {asOf})', { when, asOf });
  if (when) return t('exported {when}', { when });
  if (asOf) return t('exported unknown (as of {asOf})', { asOf });
  return t('exported unknown');
};

export const ImportNativeProject = () => {
  useDocumentTitle(t('Import archive'));
  const { client: session } = useAuth();
  // The run's own client, so a write made elsewhere in the tab meanwhile is
  // neither stamped with its document version nor filed under its operation.
  const client = useClientApart(session);
  const [archive, setArchive] = useState(null);
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
  } = useProjectImportRun({ client, kind: NATIVE_IMPORT_KIND });

  const handleFile = async (file) => {
    if (!file) return;
    setStage('parsing');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = readNativeArchive(bytes);
      setArchive(parsed);
      setProjectName(parsed.manifest.project?.name || file.name.replace(/\.zip$/i, ''));
      setStage('review');
    } catch (e) {
      console.error('Archive read failed:', e);
      notifyError(humanizeError(e), t('Failed to read the archive'));
      setStage('pick');
    }
  };

  const startImport = () =>
    start({
      source: archive.manifest?.project?.name ?? null,
      setupData: () => deriveSetupData(archive.manifest, projectName.trim(), archive.vocabularies),
      run: ({ projectId, shouldStop, setProgress }) => {
        const totalDocs = archive.documents.length;
        return runNativeImport({
          client,
          projectId,
          archive,
          shouldStop,
          onProgress: (p) => {
            if (p.phase === 'vocabulary') {
              setProgress({
                label: t('Importing vocabulary "{name}" ({done}/{total})', {
                  name: p.name,
                  done: p.done,
                  total: p.total,
                }),
                pct: 15 + (p.total ? (p.done / p.total) * 15 : 15),
              });
            } else if (p.phase === 'document') {
              setProgress({
                label: documentLabel(p, totalDocs),
                pct: 30 + documentFraction(p, totalDocs) * 70,
              });
            }
          },
        });
      },
    });

  const manifest = archive?.manifest;
  const itemCount = archive?.vocabularies.reduce((n, v) => n + (v.data.items?.length ?? 0), 0) ?? 0;
  const mediaCount = archive?.documents.filter((d) => d.mediaBytes).length ?? 0;
  const fieldCount = manifest
    ? ['sentence', 'word', 'morpheme'].reduce(
        (n, k) => n + (manifest.schema?.fields?.[k]?.length ?? 0),
        0,
      )
    : 0;

  return (
    <div className={FORM_PAGE_WIDTH}>
      <div className="flex flex-col gap-6">
        <ImportHeader title={t('Import a Plaid IGT archive')}>
          {t(
            'Recreate a project from a “Plaid IGT JSON” export: texts, analyses, vocabularies, time alignment, media, and provenance.',
          )}
        </ImportHeader>

        {stage === 'pick' && (
          <FileDropZone
            onFiles={(files) => handleFile(files?.[0])}
            title={t('Drop an exported .zip archive here, or click to choose')}
            hint={t('Produced by Export → “Plaid IGT JSON (lossless .zip archive)”')}
            accept=".zip,application/zip"
          />
        )}

        {stage === 'parsing' && <ReadingPanel label={t('Reading archive…')} />}

        {(stage === 'review' || stage === 'running' || stage === 'done') && archive && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                {t('Contents of “{name}”', { name: manifest.project?.name ?? t('archive') })}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {exportedLine(manifest)}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>
                  {t('{n, plural, one {# document} other {# documents}}', {
                    n: archive.documents.length,
                  })}
                </p>
                <p>
                  {t('{n, plural, one {# vocabulary} other {# vocabularies}}', {
                    n: archive.vocabularies.length,
                  })}
                </p>
                <p>{t('{n, plural, one {# entry} other {# entries}}', { n: itemCount })}</p>
                <p>
                  {t('{n, plural, one {# annotation field} other {# annotation fields}}', {
                    n: fieldCount,
                  })}
                </p>
                <p>
                  {t('{n, plural, one {# orthography} other {# orthographies}}', {
                    n: manifest.schema?.orthographies?.length ?? 0,
                  })}
                </p>
                <p>
                  {t('{n, plural, one {# media file} other {# media files}}', { n: mediaCount })}
                </p>
              </div>
            </div>

            <ProjectNameField
              id="native-project-name"
              value={projectName}
              onChange={setProjectName}
              disabled={stage !== 'review' || !!unfinished}
            />

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
                  {t('Imported {n, plural, one {# document} other {# documents}}', {
                    n: results.imported,
                  })}
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
              {stage === 'review' && !unfinished && (
                <Button onClick={startImport} disabled={!projectName.trim()}>
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
