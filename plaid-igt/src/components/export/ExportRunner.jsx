import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { readExportPresets, EXPORT_FORMATS } from '@/export/presets';
import { runExport, ExportCancelled } from '@/export/runExport';
import { downloadBlob } from '@/export/files';
import { ScopeStep } from './ScopeStep.jsx';

const formatLabel = (id) => EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id;

// Formats that assemble ONE dataset rather than a file per document: they zip
// at every scope and handle the project's vocabularies themselves, so the
// per-run vocabularies toggle does not apply.
const ZIP_NOTES = {
  'plaid-igt-json':
    'This format always produces a .zip archive including all vocabularies and the project ' +
    'configuration, whatever the scope.',
  cldf:
    'This format always produces a .zip dataset (one CSV per CLDF component table) whatever the ' +
    'scope. Whether the lexicon is included is set in the preset.',
  flextext:
    'This format produces one .flextext for the whole run. With the lexicon included (set in the ' +
    'preset) it becomes a .zip pairing that file with the lexicon as LIFT.',
};

// Run an export with one of the project's saved presets. Presets themselves
// (format, layers, options) are configured by ExportPresetsSettings, which sits
// directly below this on the project's Export tab. This surface only picks one
// and runs it.
//
// Two homes: a document's Export tab (defaultScope given: the scope is that
// document, no scope step) and the project's Export tab (scope step: whole
// project / selected documents). `onDone` runs after a successful export.
// asOf exports a historical state of the document.
export const ExportRunner = ({
  client,
  project,
  documents = null,
  defaultScope = null,
  asOf = null,
  canManage = false,
  showPresetsLink = true,
  presetId = null,
  onDone = null,
  onClose = null,
}) => {
  const presets = readExportPresets(project);
  // `presetId` pins the run to one preset and hides the picker: that is how the
  // preset editor runs the preset being edited, so the page never lists the
  // presets twice.
  const [selectedId, setSelectedId] = useState(presetId ?? presets[0]?.id ?? null);
  const [scope, setScope] = useState(defaultScope ? 'document' : 'project');
  const [selectedDocIds, setSelectedDocIds] = useState(() => new Set());
  const [includeVocabularies, setIncludeVocabularies] = useState(null); // null = preset's own
  const [docList, setDocList] = useState(documents);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const stopRef = useRef(false);

  const preset = presets.find((p) => p.id === selectedId) ?? null;
  // A preset deleted/added elsewhere: keep the selection valid. A pinned preset
  // follows the pin, including after a save changes the stored object.
  useEffect(() => {
    if (presetId) {
      if (selectedId !== presetId) setSelectedId(presetId);
      return;
    }
    if (!preset && presets.length) setSelectedId(presets[0].id);
  }, [preset, presets, presetId, selectedId]);

  // The scope step needs the document list; fetch it if the caller didn't
  // have one handy.
  const scopeStep = !defaultScope;
  useEffect(() => {
    if (!scopeStep || docList || !project?.id) return;
    let cancelled = false;
    client.projects
      .listDocuments(project.id)
      .then((docs) => {
        if (!cancelled) setDocList(docs || []);
      })
      .catch(() => {
        if (!cancelled) setDocList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeStep, docList, client, project?.id]);

  const run = async () => {
    if (!preset || running) return;
    const scopeArg =
      scope === 'document'
        ? { type: 'document', id: defaultScope.id }
        : scope === 'documents'
          ? { type: 'documents', ids: [...selectedDocIds] }
          : { type: 'project' };
    const effectivePreset =
      includeVocabularies == null ? preset : { ...preset, includeVocabularies };
    setRunning(true);
    stopRef.current = false;
    setProgress({ done: 0, total: 0, name: null });
    try {
      const result = await runExport({
        client,
        project,
        preset: effectivePreset,
        scope: scopeArg,
        asOf,
        onProgress: setProgress,
        shouldStop: () => stopRef.current,
      });
      downloadBlob(result.filename, result.blob);
      if (result.warnings.length) {
        notifyWarning(
          `Exported with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}: ${result.warnings.join('; ')}`,
          'Export finished',
        );
      } else {
        notifySuccess(`Downloaded ${result.filename}`, 'Export complete');
      }
      if (onDone) onDone();
    } catch (err) {
      if (err instanceof ExportCancelled) {
        notifyWarning('Export cancelled. Nothing was downloaded.', 'Export');
      } else {
        console.error('Export failed:', err);
        notifyError(err?.message || 'Export failed. Try again.', 'Export failed');
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const canRun = !!preset && (scope !== 'documents' || selectedDocIds.size > 0);
  // On the project's own Export tab the presets are managed right below this,
  // so neither the link nor the explanation belongs there.
  const settingsLink = !showPresetsLink ? null : canManage ? (
    <Link
      to={`/projects/${project?.id}/export`}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      <Settings className="h-3.5 w-3.5" /> Manage export presets
    </Link>
  ) : (
    <span className="text-xs text-muted-foreground">
      Presets are managed by project maintainers on the project's Export tab.
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Download className="h-4 w-4" />
          <span>{presetId ? 'Run this export' : `Export${defaultScope ? ':' : ''}`}</span>
          {defaultScope && (
            <span className="text-sm font-normal text-muted-foreground">{defaultScope.name}</span>
          )}
        </h2>
        {settingsLink}
      </div>

      {running ? (
        <div className="flex flex-col gap-2 py-4">
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: progress?.total ? `${(progress.done / progress.total) * 100}%` : '5%',
              }}
            />
          </div>
          <span className="text-sm text-muted-foreground">
            {progress?.total
              ? `Document ${Math.min(progress.done + 1, progress.total)} of ${progress.total}${progress.name ? `: ${progress.name}` : ''}`
              : 'Preparing…'}
          </span>
        </div>
      ) : presets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project has no export presets yet. A preset fixes the format (plain text, FLEx, CLDF,
          ELAN, or a lossless Plaid IGT archive) and which layers to include.
        </p>
      ) : (
        <>
          {!presetId && (
            <div className="flex flex-col gap-2">
              <Label>Preset</Label>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {presets.map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                      p.id === selectedId ? 'border-primary bg-accent/40' : 'hover:bg-muted/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="export-preset"
                      checked={p.id === selectedId}
                      onChange={() => setSelectedId(p.id)}
                    />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{formatLabel(p.format)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {scopeStep && preset && (
            <div className={presetId ? '' : 'border-t pt-4'}>
              <ScopeStep
                scope={scope}
                onScopeChange={setScope}
                documents={docList}
                defaultDocument={null}
                historicalOnly={!!asOf}
                selectedDocIds={selectedDocIds}
                onSelectedDocIdsChange={setSelectedDocIds}
                includeVocabularies={includeVocabularies ?? preset.includeVocabularies}
                onIncludeVocabulariesChange={setIncludeVocabularies}
                hasVocabularies={(project?.vocabs?.length ?? 0) > 0}
                zipNote={ZIP_NOTES[preset.format] ?? null}
              />
            </div>
          )}
        </>
      )}

      <div className="flex items-center justify-end gap-2">
        {running ? (
          <Button
            variant="outline"
            onClick={() => {
              stopRef.current = true;
            }}
          >
            Cancel
          </Button>
        ) : (
          <>
            {onClose && (
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            )}
            {presets.length > 0 && (
              <Button onClick={run} disabled={!canRun}>
                <Download className="h-4 w-4" /> Export
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
