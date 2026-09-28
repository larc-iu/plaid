import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Download, FileText, Trash2, TriangleAlert, Upload, X } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject, canManageProject } from '../../domain/permissions.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { humanizeError } from '../../lib/errors.js';
import { notifyError, notifySuccess, notifyWarning } from '../../lib/notify.js';
import { NotUtf8FileError, readTextFile } from '../../lib/textFile.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Progress } from '../ui/progress';
import { baseFileName, dedupeFileName, sanitizeFileName } from './archiveNames.js';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';

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
// parent and a boolean would flicker. It is a button to the keyboard: a stop in
// the tab order that Enter and Space open the file picker from.
const Dropzone = ({ onFiles, disabled, accept, children }) => {
  const [depth, setDepth] = useState(0);
  const inputRef = useRef(null);

  const take = (list) => {
    const files = [...(list || [])];
    if (files.length) onFiles(files);
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        depth > 0 ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (disabled || e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
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
        accept={accept}
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

const code = (text) => <code className="rounded bg-muted px-1 py-0.5 font-mono">{text}</code>;

/**
 * A project's Import and export tab in plaid-ud and plaid-umr: files of the
 * app's format in, one document each (or several, where a file says so), and
 * every document out as a zip of the same files.
 *
 * Import is for writers and up, export for every role. While an import runs a
 * dialog nobody can dismiss covers the page, so no tab or link behind it can
 * interrupt it, and closing the browser tab asks first.
 *
 * `tabs` is the app's project tab strip, and `setupHref(projectId)` the app's
 * page for setting the project up. `format` is the rest of the app's part:
 * - `app`: the short name the not-set-up notice uses ("UD").
 * - `extension` (".conllu"), `accept` for the file picker, `importTitle`,
 *   and `exportWhat`, what the zip holds ("CoNLL-U files").
 * - `layerInfo(project)`: the app's reading of the project, with `isConfigured`.
 * - `prepareImport({ client, project, projectId, user })`: run once per
 *   import, resolves to `importFile({ file, text, index, name, push })`, which
 *   imports one file's text and `push`es a row per document it made or
 *   refused: `{ key, name, status: 'imported' | 'rejected', warnings, reason,
 *   attached, documentId }`. A row with a `documentId` names its document
 *   as a link to it.
 * - `exportDocuments({ client, project, projectId, onProgress })`: resolves
 *   to `{ documents, entries: [{ name, text }], skipped: [{ name, reason }] }`,
 *   where `documents` is how many the project has.
 * - `zip(files: [{ path, text }])`: resolves to the zip's Blob.
 * - `exportFailure(err)`: an element that shows why an export was refused, or
 *   null for an error the toast should report.
 */
export const ProjectImportExportPage = ({ tabs: Tabs, setupHref, format }) => {
  const { projectId } = useParams();
  const { getClient, user, logout } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useDocumentTitle('Import and export', project?.name);

  // Import state
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState([]);
  // Where focus goes when an import finishes: the count of what it did.
  const resultRef = useRef(null);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0 });
  const [skipped, setSkipped] = useState([]);
  const [exportFailure, setExportFailure] = useState(null);

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
        setLoadError(humanizeError(err, 'Failed to load this project.'));
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
  // close or reload (the blocking dialog below prevents clicking away in-app).
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
  const canManage = canManageProject(project, user);
  const configured = format.layerInfo(project).isConfigured;

  const runImport = async () => {
    if (!files.length) return;
    setImporting(true);
    setResults([]);
    const client = getClient();
    const acc = [];
    const push = (row) => {
      acc.push(row);
      setResults([...acc]);
    };

    let importFile;
    try {
      importFile = await format.prepareImport({ client, project, projectId, user });
    } catch (err) {
      console.error('Import failed:', err);
      notifyError(humanizeError(err, 'Failed to import.'));
      setImporting(false);
      return;
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setImportProgress({ done: i, total: files.length, current: file.name });
      const name = baseFileName(file.name, format.extension);
      let text;
      try {
        text = await readTextFile(file);
      } catch (err) {
        push({
          key: `${i}-read`,
          file: file.name,
          name,
          status: 'rejected',
          reason: err instanceof NotUtf8FileError ? err.message : 'Failed to read the file',
        });
        continue;
      }
      try {
        await importFile({
          file,
          text,
          index: i,
          name,
          push: (row) => push({ file: file.name, ...row }),
        });
      } catch (err) {
        // A file the app's importer could not take as a whole: one row for
        // it, and the next file goes ahead.
        push({
          key: `${i}-failed`,
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
    setSkipped([]);
    setExportFailure(null);
    setExportProgress({ done: 0, total: 0 });
    const client = getClient();
    try {
      const found = await format.exportDocuments({
        client,
        project,
        projectId,
        onProgress: (done, total) => setExportProgress({ done, total }),
      });
      if (!found.documents) {
        notifyError('This project has no documents to export.');
        return;
      }
      const skippedAcc = found.skipped || [];
      setSkipped(skippedAcc);
      if (found.entries.length === 0) {
        notifyError('No documents could be exported. All are empty.');
        return;
      }
      const used = new Set();
      const blob = await format.zip(
        found.entries.map((e) => ({
          path: dedupeFileName(e.name, format.extension, used),
          text: e.text,
        })),
      );
      downloadBlob(blob, `${sanitizeFileName(project?.name)}.zip`);
      if (skippedAcc.length > 0) {
        notifyWarning(`Exported ${used.size}. ${skippedAcc.length} skipped (empty).`);
      } else {
        notifySuccess(`Exported ${used.size} document${used.size === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      const shown = format.exportFailure?.(err);
      if (shown) {
        setExportFailure(shown);
        return;
      }
      console.error('Export failed:', err);
      notifyError(humanizeError(err, 'Failed to export.'));
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <Loading />;
  if (!project)
    return (
      <Notice tone="error" role="alert">
        {loadError || 'Project not found'}
      </Notice>
    );

  const importedCount = results.filter((r) => r.status === 'imported').length;
  const rejectedCount = results.length - importedCount;

  return (
    <>
      {/* Non-dismissable while importing: the overlay blocks clicking the tabs
          and links behind it, so the import can't be interrupted by navigating
          away. The dialog's own close button is hidden for the same reason. */}
      <Dialog open={importing}>
        <DialogContent
          className="max-w-md [&>button]:hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          // The Import button it would go back to is disabled by then.
          onCloseAutoFocus={(e) => {
            if (!resultRef.current) return;
            e.preventDefault();
            resultRef.current.focus();
          }}
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

      <Tabs projectId={projectId} project={project} />

      <div className="flex flex-col gap-6">
        <h2 className="text-2xl font-semibold tracking-tight">Import and export</h2>

        {canEdit && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{format.importTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              {!configured ? (
                <Notice tone="warning" icon={TriangleAlert}>
                  <p className="font-medium">Not set up for {format.app}</p>
                  {/* Only a maintainer can make a layer, so only a maintainer
                      is offered the way to. */}
                  {canManage ? (
                    <p>
                      This project is not set up for {format.app}.{' '}
                      <Link
                        className="text-primary underline underline-offset-4"
                        to={setupHref(projectId)}
                      >
                        Set it up
                      </Link>
                      .
                    </p>
                  ) : (
                    <p>
                      This project is not set up for {format.app}. A project maintainer can set it
                      up.
                    </p>
                  )}
                </Notice>
              ) : (
                <div className="flex flex-col gap-4">
                  <Dropzone
                    disabled={importing}
                    accept={format.accept}
                    onFiles={(dropped) => setFiles((prev) => [...prev, ...dropped])}
                  >
                    <FileText className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm">
                      Drop {code(format.extension)} files here, or click to choose
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
                            <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
                              {f.name}
                            </span>
                            {!importing && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
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
                      <p
                        ref={resultRef}
                        tabIndex={-1}
                        className="mb-2 font-semibold focus:outline-none"
                      >
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
                                    <Check className="h-4 w-4 shrink-0 text-success" />
                                  ) : (
                                    <X className="h-4 w-4 shrink-0 text-destructive" />
                                  )}
                                  <span className="text-sm font-medium" dir="auto">
                                    {r.status === 'imported' && r.documentId ? (
                                      <Link
                                        className="text-primary underline-offset-4 hover:underline"
                                        to={appRoutes().document(projectId, r.documentId)}
                                      >
                                        {r.name}
                                      </Link>
                                    ) : (
                                      r.name
                                    )}
                                  </span>
                                  {/* The file name takes its own direction, the
                                      brackets stay with the chrome. */}
                                  <span className="truncate text-xs text-muted-foreground">
                                    (<span dir="auto">{r.file}</span>)
                                  </span>
                                </div>
                                {r.status === 'rejected' && (
                                  <p className="ps-6 text-xs text-destructive">{r.reason}</p>
                                )}
                                {r.status === 'imported' && r.attached && (
                                  <span className="text-xs text-muted-foreground">
                                    {' '}
                                    onto the existing document
                                  </span>
                                )}
                                {r.status === 'imported' && r.warnings?.length > 0 && (
                                  <ul className="ms-11 list-disc space-y-0.5 text-xs text-warning-foreground">
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
                          <Link to={appRoutes().documents(projectId)}>Documents</Link>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Export project</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Every document in this project as a {code('.zip')} of {format.exportWhat}.
            </p>

            <div>
              <Button onClick={runExport} disabled={exporting}>
                <Download className="h-4 w-4" />
                {exporting ? 'Exporting…' : 'Export'}
              </Button>
            </div>

            {!exporting && exportFailure}

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
              <Notice tone="warning">
                <p className="font-medium">
                  {skipped.length} document{skipped.length === 1 ? '' : 's'} skipped
                </p>
                <ul className="ms-5 list-disc space-y-0.5 text-xs">
                  {skipped.map((s, i) => (
                    <li key={i}>
                      <b dir="auto">{s.name || 'Untitled'}</b>: {s.reason}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
};
