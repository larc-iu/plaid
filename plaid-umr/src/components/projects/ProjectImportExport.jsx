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
import { importUmrDocument } from '../../domain/umrImport.js';
import { exportProjectUmr } from '../../domain/umrExport.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { canEditProject } from '@ui/domain/permissions.js';
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';

// ---- helpers --------------------------------------------------------------

const readText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });

const baseName = (name) => name.replace(/\.(umr|txt)$/i, '') || name;

// Strip characters illegal in zip entry / file names.
const sanitize = (s) => (s || 'document').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';

// Document names aren't unique, so de-dupe zip entries: `name.umr`,
// `name (2).umr`, …
const dedupeName = (name, used) => {
  const base = sanitize(name);
  let candidate = `${base}.umr`;
  let n = 2;
  while (used.has(candidate)) candidate = `${base} (${n++}).umr`;
  used.add(candidate);
  return candidate;
};

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

// A drop target with a hidden file input behind it. `dragging` is counted
// rather than set, because dragging over a child element fires dragleave on the
// parent and a boolean would flicker.
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
        accept=".umr,.txt"
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
        setLoadError(humanizeError(err, 'This project could not be loaded.'));
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
  const layerInfo = getUmrLayerInfo(project);
  const configured = layerInfo.isConfigured;

  const runImport = async () => {
    if (!files.length) return;
    setImporting(true);
    setResults([]);
    const client = getClient();
    // Layer config is the same for every document, so it is read once here and
    // passed in: otherwise the importer re-reads the project per document.
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
      const name = baseName(file.name);
      if (!text.trim()) {
        push({
          key: `${i}-empty`,
          file: file.name,
          name,
          status: 'rejected',
          reason: 'File is empty',
        });
        continue;
      }
      try {
        // One audit-log operation per imported document (text, tokens, nodes
        // and edges), labeled with the document name.
        const { warnings } = await client.withOperation(`Import UMR document "${name}"`, () =>
          importUmrDocument(client, projectId, name, text, layerInfo),
        );
        push({
          key: `${i}`,
          file: file.name,
          name,
          status: 'imported',
          warnings: warnings || [],
        });
      } catch (err) {
        push({
          key: `${i}`,
          file: file.name,
          name,
          status: 'rejected',
          reason: humanizeError(err),
        });
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
    setExportProgress({ done: 0, total: 0 });
    const client = getClient();
    try {
      const entries = await exportProjectUmr(client, projectId, layerInfo, {
        onProgress: (done, total) => setExportProgress({ done, total }),
      });
      if (!entries || entries.length === 0) {
        notifyError('This project has no documents to export.');
        return;
      }
      const zip = new JSZip();
      const used = new Set();
      for (const entry of entries) zip.file(dedupeName(entry.name, used), entry.text);
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${sanitize(project?.name)}.zip`);
      notifySuccess(`Exported ${used.size} document${used.size === 1 ? '' : 's'}.`);
    } catch (err) {
      console.error('Export failed:', err);
      notifyError(humanizeError(err, 'Export failed.'));
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
              <CardTitle className="text-lg">Import UMR files</CardTitle>
            </CardHeader>
            <CardContent>
              {!configured ? (
                <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">Not available</p>
                    <p>
                      This project&apos;s UMR layers are not set up, so there is nothing to import
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
                      Drop <code className="rounded bg-muted px-1 py-0.5 font-mono">.umr</code>{' '}
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
              <code className="rounded bg-muted px-1 py-0.5 font-mono">.zip</code> of{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">.umr</code> files.
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
          </CardContent>
        </Card>
      </div>
    </>
  );
};
