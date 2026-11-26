import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Download, FileText, Trash2, Upload, X } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { canEditProject, canManageProject } from '../../domain/permissions.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useProject } from '../../hooks/useProject.js';
import { humanizeError } from '../../lib/errors.js';
import { notifyError, notifySuccess, notifyWarning } from '../../lib/notify.js';
import { decodeText, NotUtf8FileError, readTextFile } from '../../lib/textFile.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Progress } from '../ui/progress';
import {
  baseFileName,
  dedupeFileName,
  entryFileName,
  isNamesRecord,
  namesRecord,
  NAMES_FILE,
  readNamesRecord,
} from './archiveNames.js';
import { saveBlob, sanitizeFilename } from '../../lib/download.js';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';
import { NotSetUpNotice } from './NotSetUpNotice.jsx';
import { SectionHeader } from './SectionHeader.jsx';
import { FileDropzone } from './FileDropzone.jsx';
import { msg, t, tx } from '../../lib/i18n.js';

const isZip = (file) => /\.zip$/i.test(file.name);
// What an operating system puts in a zip beside the files: macOS's
// `__MACOSX/` copies and dot-files such as `.DS_Store`. An export never names
// an entry with a leading dot (sanitizeFilename), so none is a document.
const isSystemEntry = (path) =>
  /(^|\/)__MACOSX\//.test(path) || entryFileName(path).startsWith('.');

/**
 * The dropped files as files to import, each with the document name its
 * archive records for it, or null. A `.zip` the app can open gives its
 * entries, named by the zip's own record, and a loose record names the loose
 * files beside it. A zip that cannot be opened is `{ file, failed }`.
 */
const filesToImport = async (files, unzip) => {
  const out = [];
  const looseRecord = files.find((f) => isNamesRecord(f.name));
  const looseNames = looseRecord
    ? readNamesRecord(await readTextFile(looseRecord).catch(() => ''))
    : new Map();
  for (const file of files) {
    if (file === looseRecord) continue;
    if (!unzip || !isZip(file)) {
      out.push({ file, recorded: looseNames.get(file.name) ?? null });
      continue;
    }
    let entries;
    try {
      entries = await unzip(file);
    } catch (err) {
      out.push({ file, failed: err });
      continue;
    }
    const record = entries.find((e) => isNamesRecord(e.path));
    let names = new Map();
    if (record) {
      try {
        names = readNamesRecord(decodeText(record.bytes));
      } catch {
        // A record that is not text names nothing.
      }
    }
    for (const e of entries) {
      if (e === record || isSystemEntry(e.path)) continue;
      const name = entryFileName(e.path);
      out.push({
        file: new File([e.bytes], name, { lastModified: file.lastModified }),
        recorded: names.get(name) ?? null,
      });
    }
  }
  return out;
};

const code = (text) => <code className="rounded bg-muted px-1 py-0.5 font-mono">{text}</code>;
const DROP_MESSAGE = msg('Drop <code>{extension}</code> files here, or click to choose');
const DROP_ZIP_MESSAGE = msg(
  'Drop <code>{extension}</code> or <code>.zip</code> files here, or click to choose',
);

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
 *   and `exportNote`, the whole line under Export project, which says what
 *   the zip holds ("Every document in this project as a .zip of CoNLL-U
 *   files."). `exportWhat`, the older form, is only what the zip holds
 *   ("CoNLL-U files"), put into a sentence of this page's own.
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
 * - `zip(files: [{ path, text }])`: resolves to the zip's Blob. Beside the
 *   documents it holds NAMES_FILE, each document's exact name, since an
 *   entry's name is only a safe spelling of it.
 * - `unzip(file)` (optional): resolves to a dropped zip's entries,
 *   `[{ path, bytes }]`, so the zip an export made imports as it is, each
 *   document under the name the zip records.
 * - `exportFailure(err)`: an element that shows why an export was refused, or
 *   null for an error the toast should report.
 */
export const ProjectImportExportPage = ({ tabs: Tabs, setupHref, format }) => {
  const { getClient, user } = useAuth();
  const { projectId, project, loading, error } = useProject({ logoutOnAuthError: true });
  const loadError = error ? humanizeError(error, t('Failed to load this project.')) : '';
  useDocumentTitle(t('Import and export'), project?.name);

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
      notifyError(humanizeError(err, t('Failed to import.')));
      setImporting(false);
      return;
    }

    const queue = await filesToImport(files, format.unzip);
    for (let i = 0; i < queue.length; i++) {
      const { file, recorded, failed } = queue[i];
      setImportProgress({ done: i, total: queue.length, current: file.name });
      const name = recorded ?? baseFileName(file.name, format.extension);
      if (failed) {
        push({
          key: `${i}-zip`,
          file: file.name,
          name: file.name,
          status: 'rejected',
          reason: t('Failed to open the zip'),
        });
        continue;
      }
      let text;
      try {
        text = await readTextFile(file);
      } catch (err) {
        push({
          key: `${i}-read`,
          file: file.name,
          name,
          status: 'rejected',
          reason: err instanceof NotUtf8FileError ? err.message : t('Failed to read the file'),
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

    setImportProgress({ done: queue.length, total: queue.length, current: '' });
    setImporting(false);
    setFiles([]);
    const imported = acc.filter((r) => r.status === 'imported').length;
    const rejected = acc.length - imported;
    if (imported > 0) {
      notifySuccess(
        rejected
          ? t('Imported {n, plural, one {# document} other {# documents}}, {rejected} rejected.', {
              n: imported,
              rejected,
            })
          : t('Imported {n, plural, one {# document} other {# documents}}.', { n: imported }),
      );
    } else {
      notifyError(t('No documents imported ({rejected} rejected).', { rejected }));
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
        notifyError(t('This project has no documents to export.'));
        return;
      }
      const skippedAcc = found.skipped || [];
      setSkipped(skippedAcc);
      if (found.entries.length === 0) {
        // The list under the button says why each was skipped.
        notifyError(t('No documents could be exported.'));
        return;
      }
      const used = new Set([NAMES_FILE]);
      const files = found.entries.map((e) => ({
        path: dedupeFileName(e.name, format.extension, used),
        name: e.name,
        text: e.text,
      }));
      const blob = await format.zip([
        ...files.map(({ path, text }) => ({ path, text })),
        { path: NAMES_FILE, text: namesRecord(files) },
      ]);
      const count = files.length;
      saveBlob(blob, `${sanitizeFilename(project?.name)}.zip`);
      if (skippedAcc.length > 0) {
        notifyWarning(
          t('Exported {n, plural, one {# document} other {# documents}}. {skipped} skipped.', {
            n: count,
            skipped: skippedAcc.length,
          }),
        );
      } else {
        notifySuccess(
          t('Exported {n, plural, one {# document} other {# documents}}.', { n: count }),
        );
      }
    } catch (err) {
      const shown = format.exportFailure?.(err);
      if (shown) {
        setExportFailure(shown);
        return;
      }
      console.error('Export failed:', err);
      notifyError(humanizeError(err, t('Failed to export.')));
    } finally {
      setExporting(false);
    }
  };

  if (loading)
    return (
      <div className="w-full">
        <Tabs projectId={projectId} project={null} />
        <Loading />
      </div>
    );
  if (!project)
    return (
      <Notice tone="error" role="alert">
        {loadError || t('Project not found')}
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
            <DialogTitle>{t('Importing documents')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Progress
              value={importProgress.total ? (importProgress.done / importProgress.total) * 100 : 0}
              label={t('Import progress')}
            />
            <p className="text-sm text-muted-foreground">
              {importProgress.current
                ? t('{i} of {n}: {name}', {
                    i: Math.min(importProgress.done + 1, importProgress.total),
                    n: importProgress.total,
                    name: importProgress.current,
                  })
                : t('{i} of {n}', {
                    i: Math.min(importProgress.done + 1, importProgress.total),
                    n: importProgress.total,
                  })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('Keep this tab open until the import finishes.')}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Tabs projectId={projectId} project={project} />

      <SectionHeader title={t('Import and export')} />
      <div className="flex flex-col gap-6">
        {canEdit && (
          <Card>
            <CardHeader>
              <CardTitle>{format.importTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              {!configured ? (
                <NotSetUpNotice
                  app={format.app}
                  canManage={canManage}
                  setupHref={setupHref(projectId)}
                />
              ) : (
                <div className="flex flex-col gap-4">
                  <FileDropzone
                    disabled={importing}
                    accept={format.accept}
                    onFiles={(dropped) => setFiles((prev) => [...prev, ...dropped])}
                  >
                    <FileText className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm">
                      {tx(format.unzip ? DROP_ZIP_MESSAGE : DROP_MESSAGE, {
                        extension: format.extension,
                        code,
                      })}
                    </p>
                  </FileDropzone>

                  {files.length > 0 && (
                    <div className="rounded-md border bg-muted/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-medium">
                          {t('{n, plural, one {# file queued} other {# files queued}}', {
                            n: files.length,
                          })}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setFiles([])}
                          disabled={importing}
                        >
                          {t('Clear')}
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
                                aria-label={t('Remove {name}', { name: f.name })}
                                title={t('Remove')}
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
                      {files.length ? t('Import ({n})', { n: files.length }) : t('Import')}
                    </Button>
                  </div>

                  {results.length > 0 && (
                    <div>
                      <p
                        ref={resultRef}
                        tabIndex={-1}
                        className="mb-2 font-semibold focus:outline-none"
                      >
                        {importing
                          ? rejectedCount
                            ? t('Importing, {imported} imported, {rejected} rejected', {
                                imported: importedCount,
                                rejected: rejectedCount,
                              })
                            : t('Importing, {imported} imported', { imported: importedCount })
                          : rejectedCount
                            ? t('Imported {imported} of {n}, {rejected} rejected', {
                                imported: importedCount,
                                n: results.length,
                                rejected: rejectedCount,
                              })
                            : t('Imported {imported} of {n}', {
                                imported: importedCount,
                                n: results.length,
                              })}
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
                                    {t('onto the existing document')}
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
                          <Link to={appRoutes().documents(projectId)}>{t('Documents')}</Link>
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
            <CardTitle>{t('Export project')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {format.exportNote ??
                tx('Every document in this project as a <code>.zip</code> of {what}.', {
                  what: format.exportWhat,
                  code,
                })}
            </p>

            <div>
              <Button onClick={runExport} disabled={exporting}>
                <Download className="h-4 w-4" />
                {exporting ? t('Exporting…') : t('Export')}
              </Button>
            </div>

            {!exporting && exportFailure}

            {exporting && (
              <div className="flex flex-col gap-1">
                <Progress
                  value={
                    exportProgress.total ? (exportProgress.done / exportProgress.total) * 100 : 0
                  }
                  label={t('Export progress')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('{i} of {n}', { i: exportProgress.done, n: exportProgress.total })}
                </p>
              </div>
            )}

            {skipped.length > 0 && (
              <Notice tone="warning">
                <p className="font-medium">
                  {t('{n, plural, one {# document skipped} other {# documents skipped}}', {
                    n: skipped.length,
                  })}
                </p>
                <ul className="ms-5 list-disc space-y-0.5 text-xs">
                  {skipped.map((s, i) => (
                    <li key={i}>
                      <b dir="auto">{s.name || t('Untitled')}</b>: {s.reason}
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
