// "Import from FLEx" — create a project from a FieldWorks .fwbackup file.
//
// Flow: pick file → parse client-side (streaming, drops non-IGT objects) →
// review (project name, orthography names, derived fields, alignment
// warnings) → run (shared project setup, then the import engine) → done.
//
// Resume: the created project id and setup completion are kept in refs for
// the lifetime of this page, so Retry after a mid-import failure re-runs
// against the same project; the engine skips documents already marked done
// and redoes half-imported ones.

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, FileUp, Check, X, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError, notifySuccess } from '@/utils/feedback';
import { readFwbackup } from '../../import/flex/fwbackup';
import { parseFwdata } from '../../import/flex/fwdataParser';
import { buildDocuments } from '../../import/flex/buildDocuments';
import { deriveImportConfig, runImport } from '../../import/flex/importEngine';
import { executeProjectSetup } from './setup/executeSetup';

const SCOPE_BADGE = {
  Word: 'border-transparent bg-blue-100 text-blue-700',
  Morpheme: 'border-transparent bg-violet-100 text-violet-700',
  Sentence: 'border-transparent bg-green-100 text-green-700',
};

export const ImportFlexProject = () => {
  const navigate = useNavigate();
  const { client } = useAuth();
  const fileInputRef = useRef(null);

  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [parsed, setParsed] = useState(null); // {backupName, ir, build, config}
  const [projectName, setProjectName] = useState('');
  const [orthoNames, setOrthoNames] = useState({}); // ws → display name
  const [progress, setProgress] = useState(null); // {label, pct} | null
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);

  // Survive retries within this page session (see header comment).
  const projectIdRef = useRef(null);
  const setupDoneRef = useRef(false);
  const vocabIdRef = useRef(null);
  const stopRef = useRef(false);

  const handleFile = async (file) => {
    if (!file) return;
    setStage('parsing');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Let the spinner paint before the synchronous parse occupies the thread.
      await new Promise((r) => setTimeout(r, 50));
      const { name, xml } = readFwbackup(bytes);
      const ir = parseFwdata(xml);
      const build = buildDocuments(ir);
      const config = deriveImportConfig(ir, build);
      if (build.documents.length === 0) {
        throw new Error('No interlinear texts found in this backup');
      }
      setParsed({ backupName: name, ir, build, config });
      setProjectName(name);
      setOrthoNames(Object.fromEntries(config.orthographies.map((o) => [o.ws, o.name])));
      setStage('review');
    } catch (e) {
      console.error('FLEx parse failed:', e);
      notifyError(e.message, 'Could not read backup');
      setStage('pick');
    }
  };

  const startImport = async () => {
    setStage('running');
    setRunError(null);
    stopRef.current = false;
    const vocabName = `${projectName} Lexicon`;
    try {
      const config = {
        ...parsed.config,
        orthographies: parsed.config.orthographies.map((o) => ({
          ws: o.ws,
          name: (orthoNames[o.ws] || o.ws).trim() || o.ws,
        })),
      };

      // 1. Project + layer setup (shared with the setup wizard), once.
      if (!setupDoneRef.current) {
        const setupData = {
          basicInfo: { projectName: projectName.trim() },
          orthographies: {
            orthographies: [
              { name: 'Baseline', isBaseline: true },
              ...config.orthographies.map((o) => ({ name: o.name })),
            ],
          },
          fields: {
            fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
            ignoredTokens: {
              mode: 'unicode-punctuation',
              unicodePunctuationExceptions: [],
              explicitIgnoredTokens: [],
            },
          },
          vocabulary: {
            vocabularies: [{ id: 'new-flex-lexicon', name: vocabName, enabled: true, isCustom: true }],
          },
          documentMetadata: {
            enabledFields: config.documentMetadata.map((m) => ({ name: m.name, enabled: true, isCustom: true })),
          },
        };
        const setup = await executeProjectSetup({
          client,
          isNewProject: true,
          resumeProjectId: projectIdRef.current,
          setupData,
          onProgress: (pct, msg) => setProgress({ label: msg, pct: pct * 0.1 }),
          onProjectCreated: (id) => { projectIdRef.current = id; },
        });
        if (setup.failures.length > 0) {
          throw new Error(setup.failures.join(' — '));
        }
        projectIdRef.current = setup.projectId;
        vocabIdRef.current = setup.resources.vocabularies?.[0]?.id ?? null;
        setupDoneRef.current = true;
      }

      // Resolve the lexicon vocab (a retry may not have setup resources).
      if (!vocabIdRef.current) {
        const project = await client.projects.get(projectIdRef.current);
        vocabIdRef.current = (project.vocabs || []).find((v) => v.name === vocabName)?.id ?? null;
      }
      if (!vocabIdRef.current) throw new Error('Lexicon vocabulary missing after setup');

      // 2. Lexicon + documents via the import engine.
      const totalDocs = parsed.build.documents.length;
      const res = await runImport({
        client,
        projectId: projectIdRef.current,
        build: parsed.build,
        lexicon: parsed.ir.lexicon,
        config,
        vocabId: vocabIdRef.current,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          if (p.phase === 'lexicon') {
            setProgress({
              label: `Importing lexicon (${p.done}/${p.total})`,
              pct: 10 + (p.total ? (p.done / p.total) * 20 : 20),
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
      notifySuccess(`Imported ${res.imported} document${res.imported === 1 ? '' : 's'}.`, 'Import Complete');
    } catch (e) {
      console.error('FLEx import failed:', e);
      setRunError(e.message);
      setStage('review');
      if (e.message !== 'Import cancelled') notifyError(e.message, 'Import Failed');
    }
  };

  const totalWarnings = parsed?.build.stats.warnings ?? 0;
  const warningSamples = parsed
    ? parsed.build.documents.flatMap((d) => d.warnings.map((w) => `${d.name}: ${w}`)).slice(0, 8)
    : [];

  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">Projects</Link>
          <span>/</span>
          <span>Import from FLEx</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Import from FLEx</h1>
          <p className="text-sm text-muted-foreground">
            Create a project from a FieldWorks backup (<code>.fwbackup</code>). Texts, glosses,
            morpheme analyses, translations, and the full lexicon are imported.
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
            <p className="font-medium">Drop a .fwbackup file here, or click to choose</p>
            <p className="text-sm text-muted-foreground">
              In FieldWorks: File → Project Management → Back up this Project
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".fwbackup,application/zip"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        {stage === 'parsing' && (
          <div className="flex items-center justify-center gap-3 rounded-lg border bg-card p-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            <p className="text-sm text-muted-foreground">Reading backup… large projects can take a few seconds.</p>
          </div>
        )}

        {(stage === 'review' || stage === 'running' || stage === 'done') && parsed && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">Contents of “{parsed.backupName}”</p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>{parsed.build.stats.documents} texts</p>
                <p>{parsed.build.stats.sentences.toLocaleString()} sentences</p>
                <p>{parsed.build.stats.words.toLocaleString()} words</p>
                <p>{parsed.build.stats.morphemes.toLocaleString()} morphemes</p>
                <p>{parsed.build.stats.lexiconEntries.toLocaleString()} lexicon entries</p>
                <p>{parsed.build.stats.lexiconSenses.toLocaleString()} senses</p>
              </div>
              {totalWarnings > 0 && (
                <div className="mt-3 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm">
                  <p className="font-medium text-orange-800">
                    {totalWarnings} word{totalWarnings === 1 ? '' : 's'} could not be aligned to the baseline and will be skipped:
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-orange-700">
                    {warningSamples.map((w, i) => <li key={i}>{w}</li>)}
                    {totalWarnings > warningSamples.length && <li>…and {totalWarnings - warningSamples.length} more</li>}
                  </ul>
                </div>
              )}
            </div>

            <div className="rounded-lg border bg-card p-4">
              <label className="mb-1 block text-sm font-medium" htmlFor="flex-project-name">Project name</label>
              <Input
                id="flex-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                disabled={stage !== 'review' || setupDoneRef.current}
              />
            </div>

            {parsed.config.orthographies.length > 0 && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Orthographies</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  The first vernacular writing system ({parsed.build.baselineWs}) becomes the baseline text.
                  Other writing systems on words become orthographies — rename them if you like.
                </p>
                <div className="flex flex-col gap-2">
                  {parsed.config.orthographies.map((o) => (
                    <div key={o.ws} className="flex items-center gap-3">
                      <code className="w-56 shrink-0 truncate text-xs text-muted-foreground">{o.ws}</code>
                      <Input
                        value={orthoNames[o.ws] ?? o.ws}
                        onChange={(e) => setOrthoNames((prev) => ({ ...prev, [o.ws]: e.target.value }))}
                        disabled={stage !== 'review' || setupDoneRef.current}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">Annotation fields</p>
              <div className="flex flex-wrap gap-2">
                {parsed.config.fields.map((f) => (
                  <Badge key={`${f.scope}:${f.name}`} className={SCOPE_BADGE[f.scope]}>
                    {f.name} · {f.scope}
                  </Badge>
                ))}
              </div>
            </div>

            {runError && stage === 'review' && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm">
                <div className="flex items-start gap-2">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium text-destructive">
                      {runError === 'Import cancelled' ? 'Import stopped' : 'Import failed'}
                    </p>
                    {runError !== 'Import cancelled' && <p className="mt-1 text-muted-foreground">{runError}</p>}
                    {projectIdRef.current && (
                      <p className="mt-1 text-muted-foreground">
                        Progress so far is kept — importing again resumes where it stopped.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {stage === 'review' && (
              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={() => { setParsed(null); setStage('pick'); }} disabled={setupDoneRef.current}>
                  Choose another file
                </Button>
                <Button onClick={startImport} disabled={!projectName.trim()}>
                  {projectIdRef.current ? <><RefreshCw className="h-4 w-4" /> Resume Import</> : <><FileUp className="h-4 w-4" /> Import</>}
                </Button>
              </div>
            )}

            {stage === 'running' && (
              <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                    <p className="font-medium">Importing…</p>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${progress?.pct ?? 0}%` }} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">{progress?.label ?? 'Starting…'}</p>
                    <Button variant="outline" size="sm" onClick={() => { stopRef.current = true; }}>
                      <Square className="h-3.5 w-3.5" /> Stop
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {stage === 'done' && (
              <div className="rounded-md border border-border bg-muted p-4">
                <div className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  <div className="text-sm">
                    <p className="font-medium">Import complete</p>
                    <p className="mt-1 text-muted-foreground">
                      {results?.imported ?? 0} imported
                      {results?.skipped ? `, ${results.skipped} already present` : ''}
                      {results?.redone ? `, ${results.redone} redone` : ''}.
                    </p>
                    <Button className="mt-3" onClick={() => navigate(`/projects/${projectIdRef.current}`)}>
                      Open project
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
