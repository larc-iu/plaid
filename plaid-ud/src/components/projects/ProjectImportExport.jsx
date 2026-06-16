import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Title, Paper, Stack, Group, Button, Text, Alert, Progress, List, Code,
  Center, Loader, Anchor, ScrollArea, ActionIcon, Tooltip, Modal,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import {
  IconUpload, IconX, IconCheck, IconDownload, IconFileText, IconTrash,
  IconAlertTriangle,
} from '@tabler/icons-react';
import JSZip from 'jszip';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { splitConlluByNewdoc } from '../../utils/conlluParser.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { canEditProject } from '../../utils/permissions.js';
import { notifySuccess, notifyError, notifyWarning } from '../../utils/feedback.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// ---- helpers --------------------------------------------------------------

const readText = (file) => new Promise((resolve, reject) => {
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

// ---- component ------------------------------------------------------------

export const ProjectImportExport = () => {
  const { projectId } = useParams();
  const { getClient, user, logout } = useAuth();

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

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
      if (!client) { logout(); return; }
      try {
        const p = await client.projects.get(projectId);
        if (cancelled) return;
        setProject(p);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { logout(); return; }
        setLoadError('Failed to load project: ' + (err.message || 'Unknown error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // While an import is running, guard against losing it midway: warn on tab
  // close / reload (the blocking modal below prevents clicking away in-app).
  useEffect(() => {
    if (!importing) return;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
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
    const push = (row) => { acc.push(row); setResults([...acc]); };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setImportProgress({ done: i, total: files.length, current: file.name });
      let text;
      try {
        text = await readText(file);
      } catch {
        push({ key: `${i}-read`, file: file.name, name: baseName(file.name), status: 'rejected', reason: 'Could not read file' });
        continue;
      }
      const chunks = splitConlluByNewdoc(text);
      const base = baseName(file.name);
      if (chunks.length === 0) {
        push({ key: `${i}-empty`, file: file.name, name: base, status: 'rejected', reason: 'File is empty' });
        continue;
      }
      for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        const name = chunk.id || (chunks.length > 1 ? `${base} (${c + 1})` : base);
        try {
          const { importWarnings } = await ConlluDocument.importFromConllu(client, projectId, name, chunk.text, layerInfo);
          push({ key: `${i}-${c}`, file: file.name, name, status: 'imported', warnings: importWarnings || [] });
        } catch (err) {
          push({ key: `${i}-${c}`, file: file.name, name, status: 'rejected', reason: err.message || 'Unknown error' });
        }
      }
    }

    setImportProgress({ done: files.length, total: files.length, current: '' });
    setImporting(false);
    setFiles([]);
    const imported = acc.filter(r => r.status === 'imported').length;
    const rejected = acc.length - imported;
    if (imported > 0) {
      notifySuccess(`Imported ${imported} document${imported === 1 ? '' : 's'}${rejected ? `, ${rejected} rejected` : ''}.`);
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

      await mapWithConcurrency(docs, 5, async (d) => {
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
      }, (done) => setExportProgress({ done, total: docs.length }));

      setSkipped(skippedAcc);
      if (used.size === 0) {
        notifyError('No documents could be exported (all empty or unconfigured).');
        return;
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${sanitize(project?.name)}.zip`);
      if (skippedAcc.length > 0) {
        notifyWarning(`Exported ${used.size}; ${skippedAcc.length} skipped (empty or unconfigured).`);
      } else {
        notifySuccess(`Exported ${used.size} document${used.size === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      notifyError(err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <Center py={48}><Loader /></Center>;
  if (!project) return <Alert color="red">{loadError || 'Project not found'}</Alert>;

  const importedCount = results.filter(r => r.status === 'imported').length;
  const rejectedCount = results.length - importedCount;

  return (
    <>
      {/* Non-dismissable while importing: the overlay blocks clicking the tabs /
          links behind it, so the import can't be interrupted by navigating away. */}
      <Modal
        opened={importing}
        onClose={() => {}}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        centered
        title="Importing documents"
      >
        <Stack gap="sm">
          <Progress
            value={importProgress.total ? (importProgress.done / importProgress.total) * 100 : 0}
            animated
          />
          <Text size="sm" c="dimmed">
            Importing {Math.min(importProgress.done + 1, importProgress.total)} / {importProgress.total}
            {importProgress.current ? `: ${importProgress.current}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            Please keep this tab open and don’t navigate away until the import finishes.
          </Text>
        </Stack>
      </Modal>

      <ProjectTabs projectId={projectId} project={project} />
      <Title order={2} mb="lg">Import &amp; Export</Title>

      {/* ---- IMPORT (writers and up) ---- */}
      {canEdit && (
        <Paper withBorder p="lg" radius="md" mb="xl">
          <Title order={4} mb="xs">Import CoNLL-U files</Title>
          {!configured ? (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Project not configured">
              This project’s UD layers aren’t set up yet, so documents can’t be imported.{' '}
              <Anchor component={Link} to={`/projects/${projectId}/configuration`}>Set up its layers</Anchor> first.
            </Alert>
          ) : (
            <Stack gap="md">
              <Dropzone
                onDrop={(dropped) => setFiles((prev) => [...prev, ...dropped])}
                multiple
                disabled={importing}
              >
                <Group justify="center" gap="lg" mih={120} style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept><IconUpload size={42} color="var(--mantine-color-blue-6)" /></Dropzone.Accept>
                  <Dropzone.Reject><IconX size={42} color="var(--mantine-color-red-6)" /></Dropzone.Reject>
                  <Dropzone.Idle><IconFileText size={42} color="var(--mantine-color-dimmed)" /></Dropzone.Idle>
                  <div>
                    <Text size="lg" inline>Drag <Code>.conllu</Code> files here, or click to select</Text>
                  </div>
                </Group>
              </Dropzone>

              {files.length > 0 && (
                <Paper bg="gray.0" p="sm" radius="sm">
                  <Group justify="space-between" mb="xs">
                    <Text size="sm" fw={500}>{files.length} file{files.length === 1 ? '' : 's'} queued</Text>
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setFiles([])} disabled={importing}>
                      Clear
                    </Button>
                  </Group>
                  <Stack gap={2}>
                    {files.map((f, i) => (
                      <Group key={`${f.name}-${i}`} gap="xs" wrap="nowrap">
                        <IconFileText size={14} style={{ flexShrink: 0 }} />
                        <Text size="sm" truncate style={{ flex: 1 }}>{f.name}</Text>
                        {!importing && (
                          <Tooltip label="Remove">
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color="gray"
                              onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                            >
                              <IconTrash size={13} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    ))}
                  </Stack>
                </Paper>
              )}

              <Group>
                <Button
                  onClick={runImport}
                  loading={importing}
                  disabled={!files.length || importing}
                  leftSection={<IconUpload size={16} />}
                >
                  Import{files.length ? ` (${files.length})` : ''}
                </Button>
              </Group>

              {results.length > 0 && (
                <div>
                  <Text fw={600} mb="xs">
                    Imported {importedCount} of {results.length}
                    {rejectedCount ? `, ${rejectedCount} rejected` : ''}
                  </Text>
                  <ScrollArea.Autosize mah={360}>
                    <Stack gap="xs">
                      {/* Most recent on top. */}
                      {results.slice().reverse().map((r) => (
                        <div key={r.key}>
                          <Group gap="xs" wrap="nowrap">
                            {r.status === 'imported'
                              ? <IconCheck size={16} color="var(--mantine-color-green-6)" style={{ flexShrink: 0 }} />
                              : <IconX size={16} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />}
                            <Text size="sm" fw={500}>{r.name}</Text>
                            <Text size="xs" c="dimmed" truncate>({r.file})</Text>
                          </Group>
                          {r.status === 'rejected' && (
                            <Text size="xs" c="red" pl={24}>{r.reason}</Text>
                          )}
                          {r.status === 'imported' && r.warnings?.length > 0 && (
                            <List size="xs" c="yellow.8" pl={24} withPadding spacing={2}>
                              {r.warnings.map((w, k) => <List.Item key={k}>{w}</List.Item>)}
                            </List>
                          )}
                        </div>
                      ))}
                    </Stack>
                  </ScrollArea.Autosize>
                  {!importing && importedCount > 0 && (
                    <Button
                      component={Link}
                      to={`/projects/${projectId}/documents`}
                      variant="light"
                      mt="md"
                    >
                      Go to Documents
                    </Button>
                  )}
                </div>
              )}
            </Stack>
          )}
        </Paper>
      )}

      {/* ---- EXPORT (all roles) ---- */}
      <Paper withBorder p="lg" radius="md">
        <Title order={4} mb="xs">Export project</Title>
        <Text size="sm" c="dimmed" mb="md">
          Download every document in this project as a <Code>.zip</Code> of CoNLL-U files.
        </Text>

        <Group>
          <Button
            color="green"
            onClick={runExport}
            loading={exporting}
            leftSection={<IconDownload size={16} />}
          >
            Export all as .zip
          </Button>
        </Group>

        {exporting && (
          <div style={{ marginTop: 'var(--mantine-spacing-md)' }}>
            <Progress
              value={exportProgress.total ? (exportProgress.done / exportProgress.total) * 100 : 0}
              animated
            />
            <Text size="xs" c="dimmed" mt={4}>
              Exporting {exportProgress.done} / {exportProgress.total}
            </Text>
          </div>
        )}

        {skipped.length > 0 && (
          <Alert color="yellow" mt="md" title={`${skipped.length} document${skipped.length === 1 ? '' : 's'} skipped`}>
            <List size="xs" spacing={2}>
              {skipped.map((s, i) => (
                <List.Item key={i}><b>{s.name || 'Untitled'}</b> — {s.reason}</List.Item>
              ))}
            </List>
          </Alert>
        )}
      </Paper>
    </>
  );
};
