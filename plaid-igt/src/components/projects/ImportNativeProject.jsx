// "Import archive" — recreate a project from a Plaid IGT JSON export
// (docs/native-format.md). Flow: pick file → read + validate client-side →
// review (project name, archive contents) → run (shared project setup, then
// the native import engine) → done.
//
// Resume mirrors the FLEx import page: the created project id and setup
// completion live in refs for this page session, so Retry re-runs against the
// same project; the engine skips documents already marked done, redoes
// half-imported ones, and dedupes vocab items by their stamped archive id.

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, Check, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/feedback';
import { readNativeArchive } from '../../import/native/readArchive';
import { deriveSetupData, runNativeImport } from '../../import/native/importEngine';
import { executeProjectSetup } from './setup/executeSetup';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

export const ImportNativeProject = () => {
  useDocumentTitle('Import Archive');
  const navigate = useNavigate();
  const { client } = useAuth();
  const fileInputRef = useRef(null);

  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [archive, setArchive] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [progress, setProgress] = useState(null); // {label, pct} | null
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);

  // Survive retries within this page session (see header comment).
  const projectIdRef = useRef(null);
  const setupDoneRef = useRef(false);
  const stopRef = useRef(false);

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
      notifyError(e.message, 'Could not read archive');
      setStage('pick');
    }
  };

  const startImport = async () => {
    setStage('running');
    setRunError(null);
    stopRef.current = false;
    try {
      // 1. Project + layer setup (shared with the setup wizard), once.
      if (!setupDoneRef.current) {
        const setup = await executeProjectSetup({
          client,
          isNewProject: true,
          resumeProjectId: projectIdRef.current,
          setupData: deriveSetupData(archive.manifest, projectName.trim()),
          onProgress: (pct, msg) => setProgress({ label: msg, pct: pct * 0.15 }),
          onProjectCreated: (id) => { projectIdRef.current = id; },
        });
        if (setup.failures.length > 0) throw new Error(setup.failures.join(' — '));
        projectIdRef.current = setup.projectId;
        setupDoneRef.current = true;
      }

      // 2. Vocabularies + documents via the import engine.
      const totalDocs = archive.documents.length;
      const res = await runNativeImport({
        client,
        projectId: projectIdRef.current,
        archive,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          if (p.phase === 'vocabulary') {
            setProgress({
              label: `Importing vocabulary "${p.name}" (${p.done}/${p.total})`,
              pct: 15 + (p.total ? (p.done / p.total) * 15 : 15),
            });
          } else if (p.phase === 'document') {
            setProgress({
              label: `${p.doc}${p.step ? ` — ${p.step}` : ''} (${(p.index ?? 0) + 1}/${p.total ?? totalDocs})`,
              pct: 30 + (((p.index ?? 0) + 1) / (p.total ?? totalDocs)) * 70,
            });
          }
        },
      });
      setResults(res);
      setStage('done');
      if (res.warnings.length) {
        notifyWarning(`Imported with ${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'}.`, 'Import finished');
      } else {
        notifySuccess(`Imported ${res.imported} document${res.imported === 1 ? '' : 's'}.`, 'Import Complete');
      }
    } catch (e) {
      console.error('Archive import failed:', e);
      setRunError(e.message);
      setStage('review');
      if (e.message !== 'Import cancelled') notifyError(e.message, 'Import Failed');
    }
  };

  const manifest = archive?.manifest;
  const itemCount = archive?.vocabularies.reduce((n, v) => n + (v.data.items?.length ?? 0), 0) ?? 0;
  const mediaCount = archive?.documents.filter((d) => d.mediaBytes).length ?? 0;
  const fieldCount = manifest
    ? ['sentence', 'word', 'morpheme'].reduce((n, k) => n + (manifest.schema?.fields?.[k]?.length ?? 0), 0)
    : 0;

  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">Projects</Link>
          <span>/</span>
          <Link to="/projects/new" className="hover:text-foreground hover:underline">New Project</Link>
          <span>/</span>
          <span>Import archive</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Import a Plaid IGT archive</h1>
          <p className="text-sm text-muted-foreground">
            Recreate a project from a “Plaid IGT JSON” export — texts, analyses,
            vocabularies, time alignment, media, and provenance.
          </p>
        </div>

        {stage === 'pick' && (
          <div
            className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-12 text-center hover:bg-muted/50"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Drop an exported .zip archive here, or click to choose</p>
            <p className="text-sm text-muted-foreground">
              Produced by Export → “Plaid IGT JSON (lossless .zip archive)”
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
            <p className="text-sm text-muted-foreground">Reading archive…</p>
          </div>
        )}

        {(stage === 'review' || stage === 'running' || stage === 'done') && archive && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                Contents of “{manifest.project?.name ?? 'archive'}”
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  exported {manifest.exportedAt ? new Date(manifest.exportedAt).toLocaleString() : 'unknown'}
                  {manifest.asOf ? ` (as of ${new Date(manifest.asOf).toLocaleString()})` : ''}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>{archive.documents.length} documents</p>
                <p>{archive.vocabularies.length} vocabular{archive.vocabularies.length === 1 ? 'y' : 'ies'}</p>
                <p>{itemCount.toLocaleString()} vocabulary items</p>
                <p>{fieldCount} annotation fields</p>
                <p>{(manifest.schema?.orthographies?.length ?? 0)} orthographies</p>
                <p>{mediaCount} media file{mediaCount === 1 ? '' : 's'}</p>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <label className="mb-1 block text-sm font-medium" htmlFor="native-project-name">Project name</label>
              <Input
                id="native-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                disabled={stage !== 'review' || setupDoneRef.current}
              />
            </div>

            {runError && stage === 'review' && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {runError === 'Import cancelled'
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
                  <Check className="h-4 w-4" /> Imported {results.imported} document{results.imported === 1 ? '' : 's'}
                  {results.skipped ? ` (${results.skipped} already done)` : ''}
                  {results.redone ? ` (${results.redone} redone)` : ''}
                </p>
                {results.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {results.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                    {results.warnings.length > 8 && <li>…and {results.warnings.length - 8} more</li>}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {stage === 'review' && (
                <Button onClick={startImport} disabled={!projectName.trim()}>
                  {runError ? <><RefreshCw className="h-4 w-4" /> Retry import</> : 'Create project & import'}
                </Button>
              )}
              {stage === 'running' && (
                <Button variant="outline" onClick={() => { stopRef.current = true; }}>
                  <Square className="h-4 w-4" /> Stop
                </Button>
              )}
              {stage === 'done' && (
                <Button onClick={() => navigate(`/projects/${projectIdRef.current}`)}>
                  Open project
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
