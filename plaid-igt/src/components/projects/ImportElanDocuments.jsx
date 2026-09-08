// "Add ELAN documents" — import .eaf files into a project that already exists.
//
// The same import as ImportElanProject, minus the project: the batch is read
// and mapped by the shared useElanBatch + ElanTierReview, and the engine writes
// against whatever project it is handed. Three things are particular here.
//
// FIELDS ARE THE PROJECT'S. A tier maps onto a field this project already has,
// chosen from a list, because the usual case is a corpus and a project that
// came from the same FieldWorks project under two naming conventions. Creating
// a field is possible and deliberate: it is a separate choice in the picker,
// and a name that reads like an existing field says so before the run.
//
// NOTHING IS LOCKED. The unfinished-import record (config.igt.import) sends a
// project's maintainers back to the wizard and refuses to open any document
// until the import is over, which is right for a project that is nothing but
// the import and wrong for one with a year of work in it. Resume here rests on
// the per-document stamps instead: a document an earlier run left unfinished is
// named on this screen and replaced when the same files are imported again.
//
// EMPTY TIERS ARE OFF. A corpus template carries tiers nobody has filled in
// yet, and in a project that already has its fields those would only add empty
// ones.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Upload, Check, RefreshCw, Square, AlertTriangle, Plus } from 'lucide-react';
import { Panel, WarningLog } from './ImportPanels.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/feedback';
import { runElanImport } from '../../import/elan/importEngine';
import {
  addOrthographies,
  createFields,
  existingFields,
  missingFields,
  missingOrthographies,
  similarField,
} from '../../import/elan/fieldTargets';
import { nodeLabel } from '../../import/elan/schema';
import { suggestFieldNames } from '../../import/elan/tierNaming';
import { defaultFieldName } from '../../import/elan/buildDocuments';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useElanBatch } from './elan/useElanBatch';
import { ElanTierReview, SchemaMismatch, SCOPE_OF_ROLE } from './elan/ElanTierReview.jsx';
import { ElanMediaPanel } from './elan/ElanMediaPanel.jsx';

const NEW_FIELD = '__new__';

export const ImportElanDocuments = () => {
  useDocumentTitle('Add ELAN documents');
  const { client } = useAuth();
  const { projectId } = useParams();
  const fileInputRef = useRef(null);
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [stage, setStage] = useState('pick'); // pick | parsing | review | running | done
  const [progress, setProgress] = useState(null);
  const [log, setLog] = useState([]);
  const [runError, setRunError] = useState(null);
  const [results, setResults] = useState(null);
  // Which tiers the user has explicitly set to a new field, by node key. A name
  // that happens to be new is not the same as asking for a new field: without
  // this, clearing the box would silently become "create a field called ''".
  const [creating, setCreating] = useState({});
  const stopRef = useRef(false);

  const fields = project ? existingFields(project) : { Sentence: [], Word: [], Morpheme: [] };

  const batch = useElanBatch({
    skipEmptyTiers: true,
    // Place every tier we can on the project's own fields: first by the
    // FieldWorks tier-naming convention (Translation-gls-nl → "Translation
    // (nl)"), then by a name that simply reads alike. What is left keeps the
    // tier's name and waits for the picker.
    namesFor: (nodes, roles) => {
      const entries = nodes
        .map((node) => ({
          key: node.key,
          name: defaultFieldName(node),
          scope: SCOPE_OF_ROLE[roles[node.key]],
        }))
        .filter((e) => e.scope);
      const placed = suggestFieldNames(entries, fields);
      for (const e of entries) {
        if (placed[e.key]) continue;
        const alike = similarField(fields, e.scope, e.name);
        if (alike) placed[e.key] = alike;
      }
      return placed;
    },
  });

  useEffect(() => {
    let cancelled = false;
    client.projects
      .get(projectId)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch((err) => {
        console.error('Could not load the project:', err);
        if (!cancelled) setLoadError('This project could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  const handleFiles = async (fileList) => {
    setStage('parsing');
    try {
      await batch.readFiles(fileList);
      setStage('review');
    } catch (e) {
      console.error('ELAN read failed:', e);
      notifyError(e.message, 'Could not read the files');
      setStage(batch.files ? 'review' : 'pick');
    }
  };

  // What the run would add to the project, as opposed to write into it.
  const newFields = batch.build ? missingFields(project, batch.build.schema.fields) : [];
  const newOrthographies = batch.build
    ? missingOrthographies(project, batch.build.schema.orthographies)
    : [];

  const startImport = async () => {
    setStage('running');
    setRunError(null);
    setLog([]);
    stopRef.current = false;
    try {
      if (newFields.length || newOrthographies.length) {
        setProgress({ label: 'Adding fields', pct: 2 });
        await createFields(client, project, newFields, (label) => setProgress({ label, pct: 5 }));
        await addOrthographies(client, project, newOrthographies);
        // The engine reads the project itself and so sees the new layers; this
        // re-read is for the screen, whose pickers now have them to offer.
        setProject(await client.projects.get(projectId));
      }
      const res = await runElanImport({
        client,
        projectId,
        build: batch.build,
        shouldStop: () => stopRef.current,
        onWarning: (text, { document }) => setLog((l) => [...l, { text, document }]),
        onProgress: (p) => {
          if (p.phase !== 'document') return;
          const n = (p.index ?? 0) + 1;
          const total = p.total ?? batch.build.documents.length;
          setProgress({
            label: `${p.doc}${p.step ? `: ${p.step}` : ''} (${n}/${total})`,
            pct: 10 + (n / total) * 90,
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
          `Added ${res.imported} document${res.imported === 1 ? '' : 's'}.`,
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

  const editable = stage === 'review';
  const canRun = editable && !!batch.build && batch.undecidedNearMisses.length === 0;
  const projectHref = `/projects/${projectId}`;

  // The field a tier writes to: one of the project's, or a new one by name.
  const renderFieldControl = (node) => {
    const scope = SCOPE_OF_ROLE[batch.roles[node.key]];
    if (!scope) {
      // An orthography is a name on the word layer, not a field to pick.
      return (
        <Input
          aria-label={`Name for ${nodeLabel(node)}`}
          value={batch.fieldNames[node.key] ?? ''}
          disabled={!editable}
          onChange={(e) => batch.setName(node.key, e.target.value)}
          className="h-8 w-40 shrink-0"
        />
      );
    }
    const name = batch.fieldNames[node.key] ?? '';
    const known = fields[scope].some((f) => f.name === name);
    const isNew = creating[node.key] || !known;
    return (
      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={isNew ? NEW_FIELD : name}
          disabled={!editable}
          onValueChange={(v) => {
            setCreating((c) => ({ ...c, [node.key]: v === NEW_FIELD }));
            if (v !== NEW_FIELD) batch.setName(node.key, v);
            else batch.setName(node.key, defaultFieldName(node));
          }}
        >
          <SelectTrigger className="h-8 w-44">
            <SelectValue placeholder="Choose a field" />
          </SelectTrigger>
          <SelectContent>
            {fields[scope].map((f) => (
              <SelectItem key={f.id} value={f.name}>
                {f.name}
              </SelectItem>
            ))}
            <SelectItem value={NEW_FIELD}>New field…</SelectItem>
          </SelectContent>
        </Select>
        {isNew && (
          <Input
            aria-label={`New field name for ${nodeLabel(node)}`}
            value={name}
            disabled={!editable}
            onChange={(e) => batch.setName(node.key, e.target.value)}
            className="h-8 w-40"
          />
        )}
      </div>
    );
  };

  if (loadError) {
    return (
      <div className="tw mx-auto max-w-3xl px-4 py-8">
        <Panel tone="error" icon={AlertTriangle} title={loadError} />
      </div>
    );
  }

  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
          <span>/</span>
          <Link to={projectHref} className="hover:text-foreground hover:underline">
            {project?.name ?? 'Project'}
          </Link>
          <span>/</span>
          <span>Add ELAN documents</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">Add ELAN documents</h1>
          <p className="text-sm text-muted-foreground">
            Import{' '}
            <a
              href="https://archive.mpi.nl/tla/elan"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              ELAN
            </a>{' '}
            annotation files into {project?.name ? `“${project.name}”` : 'this project'}. Every file
            becomes one document, and its tiers are written into fields this project already has.
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
              Drop your .eaf files here, or choose them below. Include the recordings to upload
              those too.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".eaf,audio/*,video/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <Button onClick={() => fileInputRef.current?.click()}>Choose files</Button>
          </div>
        )}

        {stage === 'parsing' && <p className="text-sm text-muted-foreground">Reading files…</p>}

        {(stage === 'review' || stage === 'running') && batch.comparison && project && (
          <div className="flex flex-col gap-6">
            {!batch.comparison.consistent && (
              <SchemaMismatch
                comparison={batch.comparison}
                onReset={() => {
                  batch.reset();
                  setStage('pick');
                }}
              />
            )}

            {batch.comparison.consistent && (
              <>
                <ElanTierReview
                  batch={batch}
                  editable={editable}
                  renderFieldControl={renderFieldControl}
                />

                {newFields.length > 0 && (
                  <Panel
                    tone={newFields.some((f) => f.similarTo) ? 'warn' : 'muted'}
                    icon={newFields.some((f) => f.similarTo) ? AlertTriangle : Plus}
                    title={`${newFields.length} new field${newFields.length === 1 ? '' : 's'} will be added to this project`}
                  >
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                      {newFields.map((f) => (
                        <li key={`${f.scope}:${f.name}`}>
                          <span className="font-medium">{f.name}</span> ({f.scope.toLowerCase()})
                          {f.similarTo && (
                            <span className="text-amber-700 dark:text-amber-500">
                              {' '}
                              — this project already has “{f.similarTo}”
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}

                {newOrthographies.length > 0 && (
                  <Panel
                    icon={Plus}
                    title={`${newOrthographies.length} new orthograph${newOrthographies.length === 1 ? 'y' : 'ies'}: ${newOrthographies.join(', ')}`}
                  />
                )}

                <ElanMediaPanel
                  media={batch.media}
                  files={batch.files}
                  editable={editable}
                  onRemove={(file) => batch.setMediaFiles((prev) => prev.filter((f) => f !== file))}
                />

                {runError && (
                  <Panel tone="error" icon={AlertTriangle} title="Import failed">
                    <p className="mt-1 text-xs">{runError}</p>
                    <p className="mt-1 text-xs">
                      Retrying continues where it stopped: documents that finished are skipped, and
                      one left part way is replaced.
                    </p>
                  </Panel>
                )}

                {log.length > 0 && <WarningLog log={log} />}

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
                  <Button variant="outline" asChild>
                    <Link to={projectHref}>Cancel</Link>
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-4">
            <Panel icon={Check} title="Import complete">
              <p className="mt-1 text-xs">
                {results.imported} added
                {results.skipped ? `, ${results.skipped} already there` : ''}
                {results.redone ? `, ${results.redone} replaced` : ''}.
              </p>
            </Panel>
            {log.length > 0 ? (
              <WarningLog log={log} />
            ) : (
              results.warnings.length > 0 && (
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
              )
            )}
            <div>
              <Button asChild>
                <Link to={projectHref}>Open the project</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
