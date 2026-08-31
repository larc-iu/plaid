// "Import ELAN" — create a project from a folder of .eaf files.
// Flow: pick files → read + compare tier structures → review (name, the tier
// mapping, what each tier becomes) → run (shared project setup, then the ELAN
// import engine) → done.
//
// The batch is refused outright unless every file has the same tier structure.
// One mapping is applied to the whole corpus, so a file with different tiers
// would be imported under decisions that were never made for it. See
// import/elan/schema.js for what "the same structure" means (participants are
// normalized out, so files by different speakers still match).
//
// Resume mirrors the other import pages: the created project id and setup
// completion live in refs for this page session, so Retry re-runs against the
// same project and the engine skips documents already marked done.

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
import { readEaf } from '../../import/elan/readEaf';
import {
  compareSchemas,
  suggestRoles,
  validateRoles,
  nodeLabel,
  ROLES,
} from '../../import/elan/schema';
import { buildElanDocuments, defaultFieldName } from '../../import/elan/buildDocuments';
import { deriveSetupData, runElanImport } from '../../import/elan/importEngine';
import { executeProjectSetup } from './setup/executeSetup';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const ROLE_LABELS = [
  [ROLES.UTTERANCE, 'Utterances'],
  [ROLES.ALIGNMENT, 'Time alignment'],
  [ROLES.WORD, 'Words'],
  [ROLES.MORPHEME, 'Morphemes'],
  [ROLES.SENTENCE_FIELD, 'Sentence field'],
  [ROLES.WORD_FIELD, 'Word field'],
  [ROLES.MORPH_FIELD, 'Morpheme field'],
  [ROLES.ORTHOGRAPHY, 'Orthography'],
  [ROLES.OFF, 'Don’t import'],
];
const NAMED_ROLES = new Set([
  ROLES.SENTENCE_FIELD,
  ROLES.WORD_FIELD,
  ROLES.MORPH_FIELD,
  ROLES.ORTHOGRAPHY,
]);

const Panel = ({ tone = 'muted', icon: Icon, title, children }) => {
  const tones = {
    muted: 'border-border bg-muted/40',
    warn: 'border-amber-500/40 bg-amber-500/10',
    error: 'border-destructive/40 bg-destructive/10',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tones[tone]}`}>
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
};

export const ImportElanProject = () => {
  useDocumentTitle('Import ELAN');
  const { client } = useAuth();
  const fileInputRef = useRef(null);

  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  // One decision per near-miss pair, keyed by the pair's folded name: either
  // 'separate' (they really are two tiers) or the name to merge them onto. The
  // import is blocked until every pair has one. Reset on every new pick, so a
  // decision never carries over to a different batch.
  const [nearMissChoices, setNearMissChoices] = useState({});
  // The pairs themselves come from the UNMERGED schema, so a pair stays on
  // screen (and stays changeable) after it has been merged away.
  const [nearMissGroups, setNearMissGroups] = useState([]);
  const [files, setFiles] = useState(null); // parsed .eaf objects
  const [comparison, setComparison] = useState(null);
  const [roles, setRoles] = useState({});
  const [fieldNames, setFieldNames] = useState({});
  const [projectName, setProjectName] = useState('');
  const [progress, setProgress] = useState(null);
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);

  const projectIdRef = useRef(null);
  const setupDoneRef = useRef(false);
  const stopRef = useRef(false);

  const nodes = comparison?.nodes ?? [];
  const problems = useMemo(
    () => (comparison?.consistent ? validateRoles(nodes, roles) : []),
    [comparison, nodes, roles],
  );

  // Re-derived whenever a mapping choice changes, so the review numbers always
  // describe what the import would actually do.
  const build = useMemo(() => {
    if (!files || !comparison?.consistent || problems.length) return null;
    try {
      return buildElanDocuments(files, nodes, roles, { fieldNames });
    } catch (e) {
      console.error('ELAN build failed:', e);
      return null;
    }
  }, [files, comparison, nodes, roles, fieldNames, problems]);

  // Adopt a schema: suggest the roles and field names for it, keeping whatever
  // the user has already chosen for nodes that survive. A merge changes node
  // keys, so the mapping has to be rebuilt rather than carried over wholesale.
  const applySchema = (parsed, result) => {
    setComparison(result);
    const suggested = result.consistent ? suggestRoles(result.nodes) : {};
    setRoles((prev) => {
      const next = { ...suggested };
      for (const n of result.nodes) if (prev[n.key] !== undefined) next[n.key] = prev[n.key];
      return next;
    });
    setFieldNames((prev) =>
      Object.fromEntries(result.nodes.map((n) => [n.key, prev[n.key] ?? defaultFieldName(n)])),
    );
  };

  // Re-read the batch under a new set of merge decisions.
  const chooseNearMiss = (fold, choice) => {
    const choices = { ...nearMissChoices, [fold]: choice };
    setNearMissChoices(choices);
    const canonical = new Map(
      Object.entries(choices).filter(([, v]) => v !== 'separate' && v !== undefined),
    );
    applySchema(files, compareSchemas(files, canonical.size ? canonical : null));
  };

  const handleFiles = async (fileList) => {
    const picked = [...(fileList || [])].filter((f) => /\.eaf$/i.test(f.name));
    if (!picked.length) {
      notifyError('Choose one or more .eaf files.', 'Nothing to import');
      return;
    }
    setStage('parsing');
    try {
      const parsed = [];
      for (const file of picked) {
        parsed.push(readEaf(await file.text(), file.name));
      }
      const result = compareSchemas(parsed);
      setFiles(parsed);
      setNearMissGroups(result.nearMisses);
      setNearMissChoices({});
      applySchema(parsed, result);
      setProjectName((name) => name || 'ELAN corpus');
      setStage('review');
    } catch (e) {
      console.error('ELAN read failed:', e);
      notifyError(e.message, 'Could not read the files');
      setStage('pick');
    }
  };

  const setRole = (key, role) => setRoles((r) => ({ ...r, [key]: role }));
  const setName = (key, name) => setFieldNames((n) => ({ ...n, [key]: name }));

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

      const res = await runElanImport({
        client,
        projectId: projectIdRef.current,
        build,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          if (p.phase !== 'document') return;
          const n = (p.index ?? 0) + 1;
          const total = p.total ?? build.documents.length;
          setProgress({
            label: `${p.doc}${p.step ? `: ${p.step}` : ''} (${n}/${total})`,
            pct: 15 + (n / total) * 85,
          });
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
      console.error('ELAN import failed:', e);
      setRunError(e.message);
      setStage('review');
      if (!/cancelled/i.test(e.message)) notifyError(e.message, 'Import failed');
    }
  };

  const undecidedNearMisses = nearMissGroups.filter((g) => !nearMissChoices[g.fold]);
  const editable = stage === 'review';
  const canRun = editable && !!build && !!projectName.trim() && undecidedNearMisses.length === 0;

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
          <span>Import ELAN</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Import an ELAN corpus</h1>
          <p className="text-sm text-muted-foreground">
            Create a project from a set of{' '}
            <a
              href="https://archive.mpi.nl/tla/elan"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              ELAN
            </a>{' '}
            annotation files. Every file becomes one document, and every file must share the same
            tier structure so one set of decisions covers the whole corpus.
          </p>
        </div>

        {stage === 'pick' && (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-10 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Drop your .eaf files here, or choose them below. Media files are not imported.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".eaf"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <Button onClick={() => fileInputRef.current?.click()}>Choose .eaf files</Button>
          </div>
        )}

        {stage === 'parsing' && <p className="text-sm text-muted-foreground">Reading files…</p>}

        {(stage === 'review' || stage === 'running') && comparison && (
          <div className="flex flex-col gap-6">
            {!comparison.consistent && (
              <Panel
                tone="error"
                icon={AlertTriangle}
                title="These files do not share one tier structure"
              >
                <p className="mt-1 text-xs">
                  One mapping has to describe the whole batch, so importing a mixture would apply
                  decisions to files they were never made for. Import each structure separately, or
                  make the tiers match in ELAN first.
                </p>
                <ul className="mt-2 flex flex-col gap-2 text-xs">
                  {comparison.differences.map((d, i) => (
                    <li key={i}>
                      <span className="font-medium">
                        {d.files.length} file{d.files.length === 1 ? '' : 's'}
                      </span>{' '}
                      ({d.files.slice(0, 3).join(', ')}
                      {d.files.length > 3 ? `, +${d.files.length - 3} more` : ''}):
                      {d.missing.length > 0 && <> missing {d.missing.join(', ')}.</>}
                      {d.extra.length > 0 && <> extra {d.extra.join(', ')}.</>}
                      {d.nearMiss?.length > 0 && (
                        <>
                          {' '}
                          <span className="font-medium">
                            {d.nearMiss.join(', ')} differs only in how it is spelled
                          </span>
                          , which is likely a typo in the tier name rather than a real difference.
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setFiles(null);
                    setComparison(null);
                    setStage('pick');
                  }}
                >
                  Choose different files
                </Button>
              </Panel>
            )}

            {comparison.consistent && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="project-name">Project name</Label>
                  <Input
                    id="project-name"
                    value={projectName}
                    disabled={!editable}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="max-w-md"
                  />
                </div>

                {nearMissGroups.length > 0 && (
                  <Panel
                    tone={undecidedNearMisses.length ? 'error' : 'warn'}
                    icon={AlertTriangle}
                    title={`${nearMissGroups.length} pair${nearMissGroups.length === 1 ? '' : 's'} of tier names read alike`}
                  >
                    <p className="mt-1 text-xs">
                      Tiers are matched by their exact names, so these are separate tiers unless you
                      say otherwise. Two rows that read alike is how a tier gets mapped by mistake
                      and its twin silently dropped, so this usually means a typo in the corpus.
                    </p>
                    <div className="mt-2 flex flex-col gap-2">
                      {nearMissGroups.map((g) => (
                        <div key={g.fold} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-medium">{g.names.join(' / ')}</span>
                          <span className="text-muted-foreground">
                            differ only in {g.differsBy}
                          </span>
                          <Select
                            value={nearMissChoices[g.fold] ?? ''}
                            onValueChange={(v) => chooseNearMiss(g.fold, v)}
                            disabled={!editable}
                          >
                            <SelectTrigger className="h-7 w-56 text-xs">
                              <SelectValue placeholder="Decide…" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="separate">Different tiers, keep both</SelectItem>
                              {g.names.map((n) => (
                                <SelectItem key={n} value={n}>
                                  Same tier, merge as “{n}”
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                    {undecidedNearMisses.length > 0 && (
                      <p className="mt-2 text-xs font-medium">
                        Decide each pair to continue. Renaming the tiers in ELAN is the durable fix.
                      </p>
                    )}
                  </Panel>
                )}

                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Tiers</h2>
                    <p className="text-sm text-muted-foreground">
                      {files.length} file{files.length === 1 ? '' : 's'}, all with the same{' '}
                      {nodes.length} tier{nodes.length === 1 ? '' : 's'}. Speaker suffixes are
                      ignored when matching, so files by different speakers count as the same
                      structure.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {nodes.map((node) => (
                      <div key={node.key} className="flex items-center gap-2">
                        <div
                          className="min-w-0 flex-1 truncate text-sm"
                          style={{ paddingLeft: `${node.depth * 16}px` }}
                          title={`type ${node.typeRef}${node.stereotype ? `, ${node.stereotype}` : ''}`}
                        >
                          <span className="font-medium">{nodeLabel(node)}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {node.stereotype ?? 'top level'} · {node.annotationCount}
                            {node.participants.length > 1
                              ? ` · ${node.participants.length} speakers`
                              : ''}
                            {' · '}
                            <span className="font-mono">{node.tierIds.slice(0, 3).join(' ')}</span>
                            {node.tierIds.length > 3 ? ` +${node.tierIds.length - 3}` : ''}
                          </span>
                        </div>
                        {NAMED_ROLES.has(roles[node.key]) && (
                          <Input
                            aria-label={`Name for ${nodeLabel(node)}`}
                            value={fieldNames[node.key] ?? ''}
                            disabled={!editable}
                            onChange={(e) => setName(node.key, e.target.value)}
                            className="h-8 w-40 shrink-0"
                          />
                        )}
                        <Select
                          value={roles[node.key] ?? ROLES.OFF}
                          disabled={!editable}
                          onValueChange={(v) => setRole(node.key, v)}
                        >
                          <SelectTrigger className="h-8 w-44 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLE_LABELS.map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                {problems.length > 0 && (
                  <Panel tone="warn" icon={AlertTriangle} title="Finish the mapping">
                    <ul className="mt-1 list-inside list-disc text-xs">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </Panel>
                )}

                {build && (
                  <Panel title="What will be imported">
                    <p className="mt-1 text-xs">
                      {build.documents.length} document
                      {build.documents.length === 1 ? '' : 's'} · {build.stats.sentences} sentences
                      · {build.stats.words} words · {build.stats.morphemes} morphemes ·{' '}
                      {build.stats.alignments} time-aligned segments
                      {build.stats.speakers.length > 0 && (
                        <> · speakers: {build.stats.speakers.join(', ')}</>
                      )}
                    </p>
                    {build.warnings.length > 0 && (
                      <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
                        {build.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </Panel>
                )}

                {build && build.stats.skipped.length > 0 && (
                  <Panel
                    tone="warn"
                    icon={AlertTriangle}
                    title={`Not imported: ${build.stats.skipped.reduce((n, s) => n + s.values, 0)} annotations on ${build.stats.skipped.length} tier${build.stats.skipped.length === 1 ? '' : 's'}`}
                  >
                    <p className="mt-1 text-xs">
                      These tiers are set to “Don’t import” above. Give one a role to keep it.
                    </p>
                    <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
                      {build.stats.skipped.map((sk) => (
                        <li key={sk.label}>
                          {sk.tiers.join(', ')} — {sk.values} annotation
                          {sk.values === 1 ? '' : 's'}
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}

                {runError && (
                  <Panel tone="error" icon={AlertTriangle} title="Import failed">
                    <p className="mt-1 text-xs">{runError}</p>
                    <p className="mt-1 text-xs">
                      Retrying continues in the same project: finished documents are skipped.
                    </p>
                  </Panel>
                )}

                {stage === 'running' && progress && (
                  <div className="flex flex-col gap-2">
                    <div className="h-2 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${Math.min(100, Math.round(progress.pct))}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">{progress.label}</p>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button onClick={startImport} disabled={!canRun}>
                    {runError ? (
                      <>
                        <RefreshCw className="h-4 w-4" /> Retry import
                      </>
                    ) : (
                      'Import'
                    )}
                  </Button>
                  {stage === 'running' && (
                    <Button variant="outline" onClick={() => (stopRef.current = true)}>
                      <Square className="h-4 w-4" /> Stop
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-4">
            <Panel icon={Check} title="Import complete">
              <p className="mt-1 text-xs">
                {results.imported} imported
                {results.skipped ? `, ${results.skipped} already done` : ''}
                {results.redone ? `, ${results.redone} redone` : ''}.
              </p>
            </Panel>
            {results.warnings.length > 0 && (
              <Panel
                tone="warn"
                icon={AlertTriangle}
                title={`${results.warnings.length} warning${results.warnings.length === 1 ? '' : 's'}`}
              >
                <ul className="mt-1 list-inside list-disc text-xs">
                  {results.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Panel>
            )}
            <div>
              <Button asChild>
                <Link to={`/projects/${projectIdRef.current}`}>Open the project</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
