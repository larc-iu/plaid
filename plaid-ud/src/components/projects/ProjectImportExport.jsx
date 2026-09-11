import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Check, Download, FileText, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { Progress } from '@ui/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import JSZip from 'jszip';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { splitConlluByNewdoc } from '../../utils/conlluParser.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { canEditProject } from '../../utils/permissions.js';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/feedback.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

// ---- helpers --------------------------------------------------------------

const readText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });

const baseName = (name) => name.replace(/\.(conllu|txt)$/i, '') || name;

// Strip characters illegal in zip entry / file names.
const sanitize = (s) => (s || 'document').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';

// Document names aren't unique, so de-dupe zip entries: `name.conllu`,
// `name (2).conllu`, …
const dedupeName = (name, used) => {
  const base = sanitize(name);
  let candidate = `${base}.conllu`;
  let n = 2;
  while (used.has(candidate)) candidate = `${base} (${n++}).conllu`;
  used.add(candidate);
  return candidate;
};

// `toConllu()` returns a `#`-prefixed sentinel (not a throw) for documents that
// can't be serialized (project unconfigured / no tokenized content). A real
// export begins with `# newdoc id = …`.
const isExportError = (t) =>
  t.startsWith('# Project configuration incomplete') ||
  t.startsWith('# No tokenized content available');

// Reuse ExportEditor's Blob/anchor download idiom.
const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = filename;
  window.document.body.appendChild(a);
  a.click();
  window.document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Run `fn` over `items` with at most `limit` in flight; `onProgress(done)`
// fires after each completion.
async function mapWithConcurrency(items, limit, fn, onProgress) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// A drop target with a hidden file input behind it. @mantine/dropzone did this
// and nothing else that this screen used, so it goes with the rest of Mantine.
// `dragging` is counted rather than set, because dragging over a child element
// fires dragleave on the parent and a boolean would flicker.
const Dropzone = ({ onFiles, disabled, children }) => {
  const [depth, setDepth] = useState(0);
  const inputRef = useRef(null);

  const take = (list) => {
    const files = [...(list || [])];
    if (files.length) onFiles(files);
  };

  return (
    <div
      className={cn(
        'flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors',
        depth > 0 ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault();
        setDepth((d) => d + 1);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDepth(0);
        take(e.dataTransfer?.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files);
          // Let the same file be picked twice in a row.
          e.target.value = '';
        }}
      />
      {children}
    </div>
  );
};

// ---- component ------------------------------------------------------------

export const ProjectImportExport = () => {
  const { projectId } = useParams();
  const { getClient, user, logout } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useDocumentTitle('Import / Export', project?.name);

  // Import state
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState([]);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0 });
  const [skipped, setSkipped] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const client = getClient();
      if (!client) {
        logout();
        return;
      }
      try {
        const p = await client.projects.get(projectId);
        if (cancelled) return;
        setProject(p);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          logout();
          return;
        }
        setLoadError('Failed to load project: ' + (err.message || 'Unknown error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // While an import is running, guard against losing it midway: warn on tab
  // close / reload (the blocking modal below prevents clicking away in-app).
  useEffect(() => {
    if (!importing) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [importing]);

  const canEdit = canEditProject(project, user);
  const configured = getUdLayerInfo(project).isConfigured;

  const runImport = async () => {
    if (!files.length) return;
    setImporting(true);
    setResults([]);
    const client = getClient();
    // Layer config is the same for every document, so read it once and pass it
    // in — otherwise importFromConllu re-fetches it (a full includeBody read) per
    // document, which roughly doubles import time on a big set.
    const layerInfo = getUdLayerInfo(project);
    const acc = [];
    const push = (row) => {
      acc.push(row);
      setResults([...acc]);
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setImportProgress({ done: i, total: files.length, current: file.name });
      let text;
      try {
        text = await readText(file);
      } catch {
        push({
          key: `${i}-read`,
          file: file.name,
          name: baseName(file.name),
          status: 'rejected',
          reason: 'Could not read file',
        });
        continue;
      }
      const chunks = splitConlluByNewdoc(text);
      const base = baseName(file.name);
      if (chunks.length === 0) {
        push({
          key: `${i}-empty`,
          file: file.name,
          name: base,
          status: 'rejected',
          reason: 'File is empty',
        });
        continue;
      }
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const name = chunk.id || (chunks.length > 1 ? `${base} (${c + 1})` : base);
        try {
          // One audit-log operation per imported document (text + tokens +
          // annotations), labeled with the document name.
          const { importWarnings } = await client.withOperation(
            `Import CoNLL-U document "${name}"`,
            () => ConlluDocument.importFromConllu(client, projectId, name, chunk.text, layerInfo),
          );
          push({
            key: `${i}-${c}`,
            file: file.name,
            name,
            status: 'imported',
            warnings: importWarnings || [],
          });
        } catch (err) {
          push({
            key: `${i}-${c}`,
            file: file.name,
            name,
            status: 'rejected',
            reason: err.message || 'Unknown error',
          });
        }
      }
    }

    setImportProgress({ done: files.length, total: files.length, current: '' });
    setImporting(false);
    setFiles([]);
    const imported = acc.filter((r) => r.status === 'imported').length;
    const rejected = acc.length - imported;
    if (imported > 0) {
      notifySuccess(
        `Imported ${imported} document${imported === 1 ? '' : 's'}${rejected ? `, ${rejected} rejected` : ''}.`,
      );
    } else {
      notifyError(`No documents imported (${rejected} rejected).`);
    }
  };

  const runExport = async () => {
    setExporting(true);
    setSkipped([]);
    setExportProgress({ done: 0, total: 0 });
    const client = getClient();
    try {
      const docs = await client.projects.listDocuments(projectId);
      if (!docs || docs.length === 0) {
        notifyError('This project has no documents to export.');
        return;
      }
      setExportProgress({ done: 0, total: docs.length });
      const zip = new JSZip();
      const used = new Set();
      const skippedAcc = [];

      await mapWithConcurrency(
        docs,
        5,
        async (d) => {
          try {
            const doc = await ConlluDocument.load(client, projectId, d.id);
            const t = doc.toConllu();
            if (isExportError(t)) {
              skippedAcc.push({ name: d.name, reason: t.replace(/^#\s*/, '') });
            } else {
              zip.file(dedupeName(d.name, used), t);
            }
          } catch (err) {
            skippedAcc.push({ name: d.name, reason: err.message || 'Failed to load' });
          }
        },
        (done) => setExportProgress({ done, total: docs.length }),
      );

      setSkipped(skippedAcc);
      if (used.size === 0) {
        notifyError('No documents could be exported (all empty or unconfigured).');
        return;
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${sanitize(project?.name)}.zip`);
      if (skippedAcc.length > 0) {
        notifyWarning(
          `Exported ${used.size}. ${skippedAcc.length} skipped (empty or unconfigured).`,
        );
      } else {
        notifySuccess(`Exported ${used.size} document${used.size === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      notifyError(err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project)
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {loadError || 'Project not found'}
      </div>
    );

  const importedCount = results.filter((r) => r.status === 'imported').length;
  const rejectedCount = results.length - importedCount;

  return (
    <>
      {/* Non-dismissable while importing: the overlay blocks clicking the tabs /
          links behind it, so the import can't be interrupted by navigating away.
          The dialog's own close button is hidden for the same reason. */}
      <Dialog open={importing}>
        <DialogContent
          className="max-w-md [&>button]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Importing documents</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Progress
              value={importProgress.total ? (importProgress.done / importProgress.total) * 100 : 0}
              label="Import progress"
            />
            <p className="text-sm text-muted-foreground">
              {Math.min(importProgress.done + 1, importProgress.total)} of {importProgress.total}
              {importProgress.current ? `: ${importProgress.current}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">
              Keep this tab open until the import finishes.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <ProjectTabs projectId={projectId} project={project} />

      <div className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold tracking-tight">Import and export</h2>

        {/* ---- IMPORT (writers and up) ---- */}
        {canEdit && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Import CoNLL-U files</CardTitle>
            </CardHeader>
            <CardContent>
              {!configured ? (
                <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Not available</p>
                    <p>
                      This project&apos;s UD layers are not set up, so there is nothing to import
                      into.{' '}
                      <Link
                        className="text-primary underline underline-offset-4"
                        to={`/projects/${projectId}/configuration`}
                      >
                        Set up its layers
                      </Link>{' '}
                      first.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <Dropzone
                    disabled={importing}
                    onFiles={(dropped) => setFiles((prev) => [...prev, ...dropped])}
                  >
                    <FileText className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm">
                      Drop <code className="rounded bg-muted px-1 py-0.5 font-mono">.conllu</code>{' '}
                      files here, or click to choose
                    </p>
                  </Dropzone>

                  {files.length > 0 && (
                    <div className="rounded-md border bg-muted/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-medium">
                          {files.length} file{files.length === 1 ? '' : 's'} queued
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setFiles([])}
                          disabled={importing}
                        >
                          Clear
                        </Button>
                      </div>
                      <div className="flex flex-col gap-1">
                        {files.map((f, i) => (
                          <div key={`${f.name}-${i}`} className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                            {!importing && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6"
                                aria-label={`Remove ${f.name}`}
                                title="Remove"
                                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <Button onClick={runImport} disabled={!files.length || importing}>
                      <Upload className="h-4 w-4" />
                      Import{files.length ? ` (${files.length})` : ''}
                    </Button>
                  </div>

                  {results.length > 0 && (
                    <div>
                      <p className="mb-2 font-semibold">
                        Imported {importedCount} of {results.length}
                        {rejectedCount ? `, ${rejectedCount} rejected` : ''}
                      </p>
                      <div className="max-h-[360px] overflow-y-auto">
                        <div className="flex flex-col gap-2">
                          {/* Most recent on top. */}
                          {results
                            .slice()
                            .reverse()
                            .map((r) => (
                              <div key={r.key}>
                                <div className="flex items-center gap-2">
                                  {r.status === 'imported' ? (
                                    <Check className="h-4 w-4 shrink-0 text-green-600" />
                                  ) : (
                                    <X className="h-4 w-4 shrink-0 text-destructive" />
                                  )}
                                  <span className="text-sm font-medium">{r.name}</span>
                                  <span className="truncate text-xs text-muted-foreground">
                                    ({r.file})
                                  </span>
                                </div>
                                {r.status === 'rejected' && (
                                  <p className="pl-6 text-xs text-destructive">{r.reason}</p>
                                )}
                                {r.status === 'imported' && r.warnings?.length > 0 && (
                                  <ul className="ml-11 list-disc space-y-0.5 text-xs text-amber-700">
                                    {r.warnings.map((w, k) => (
                                      <li key={k}>{w}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                        </div>
                      </div>
                      {!importing && importedCount > 0 && (
                        <Button variant="outline" className="mt-4" asChild>
                          <Link to={`/projects/${projectId}/documents`}>Documents</Link>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ---- EXPORT (all roles) ---- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Export project</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Every document in this project as a{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">.zip</code> of CoNLL-U files.
            </p>

            <div>
              <Button onClick={runExport} disabled={exporting}>
                <Download className="h-4 w-4" />
                {exporting ? 'Exporting…' : 'Export'}
              </Button>
            </div>

            {exporting && (
              <div className="flex flex-col gap-1">
                <Progress
                  value={
                    exportProgress.total ? (exportProgress.done / exportProgress.total) * 100 : 0
                  }
                  label="Export progress"
                />
                <p className="text-xs text-muted-foreground">
                  {exportProgress.done} of {exportProgress.total}
                </p>
              </div>
            )}

            {skipped.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
                <p className="font-medium">
                  {skipped.length} document{skipped.length === 1 ? '' : 's'} skipped
                </p>
                <ul className="ml-5 list-disc space-y-0.5 text-xs">
                  {skipped.map((s, i) => (
                    <li key={i}>
                      <b>{s.name || 'Untitled'}</b>: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
};
