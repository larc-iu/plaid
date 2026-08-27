import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readExportPresets, writeExportPresets, newPreset } from '@/export/presets';
import { runExport, ExportCancelled } from '@/export/runExport';
import { downloadBlob } from '@/export/files';
import { PresetStep } from './PresetStep.jsx';
import { PlainTextOptions } from './PlainTextOptions.jsx';
import { FlextextOptions } from './FlextextOptions.jsx';
import { NativeOptions } from './NativeOptions.jsx';
import { ScopeStep } from './ScopeStep.jsx';

const STEPS = ['preset', 'options', 'scope'];
const STEP_TITLES = { preset: 'Preset', options: 'Options', scope: 'Scope' };

// Export wizard: preset → options → scope → run. Presets persist per project
// under config.igt.export.presets (maintainer writes; everyone else gets
// session-only presets and can still export).
//
// Lives in two places: inline as a document's Export tab (ExportWizard) and in
// a modal on the project page (ExportDialog). `active` (re)initializes the
// wizard each time it is shown; `onClose`, when given, adds a Close button and
// is called after a successful export (the modal closes; the tab just returns
// to the preset step).
//
// defaultScope (optional): { type: 'document', id, name } when launched from a
// document page — preselects "this document". asOf (optional) locks the wizard
// to that document and exports its historical state.
export const ExportWizard = ({
  active = true,
  onClose = null,
  client,
  project,
  documents = null,
  defaultScope = null,
  canSavePresets = false,
  asOf = null,
}) => {
  const open = active;
  const [step, setStep] = useState('preset');
  const [presets, setPresets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [scope, setScope] = useState(defaultScope ? 'document' : 'project');
  const [selectedDocIds, setSelectedDocIds] = useState(() => new Set());
  const [docList, setDocList] = useState(documents);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const stopRef = useRef(false);
  // Presets edited this session, surviving close/reopen. The `project` prop is
  // not refreshed after writeExportPresets succeeds, so re-reading the config
  // on every open would make a just-saved (or session-only) preset vanish.
  const sessionRef = useRef({ projectId: null, presets: null, dirty: false });

  const layers = useMemo(() => discoverExportLayers(project), [project]);
  const preset = presets.find((p) => p.id === selectedId) ?? null;

  // (Re)initialize each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const session = sessionRef.current;
    const cached = session.projectId === project?.id ? session.presets : null;
    const initial = cached ?? readExportPresets(project).map((p) => JSON.parse(JSON.stringify(p)));
    setPresets(initial);
    setSelectedId(initial[0]?.id ?? null);
    setStep('preset');
    setScope(defaultScope ? 'document' : 'project');
    setSelectedDocIds(new Set());
    setDirty(cached ? session.dirty : false);
    setDocList(documents ?? null); // resync; null triggers the fetch below
    setProgress(null);
    stopRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Mirror preset edits into the session cache.
  useEffect(() => {
    if (!open || !project?.id) return;
    sessionRef.current = { projectId: project.id, presets, dirty };
  }, [open, project?.id, presets, dirty]);

  // The scope step needs the document list; fetch it if the caller didn't
  // have one handy (document page).
  useEffect(() => {
    if (!open || docList || !project?.id) return;
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
  }, [open, docList, client, project?.id]);

  const updatePreset = (patch) => {
    setPresets((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
    setDirty(true);
  };

  const persistPresets = async (next) => {
    if (!canSavePresets) {
      notifyWarning(
        'You are not a maintainer of this project, so presets last only for this session.',
        'Preset not saved',
      );
      setDirty(false);
      return;
    }
    try {
      await writeExportPresets(client, project.id, next);
      setDirty(false);
      notifySuccess('Export presets saved to the project.', 'Presets saved');
    } catch (err) {
      console.error('Failed to save export presets:', err);
      notifyError(
        'Saving export presets failed — they will last only for this session.',
        'Preset save failed',
      );
    }
  };

  const run = async () => {
    if (!preset || running) return;
    const scopeArg =
      scope === 'document'
        ? { type: 'document', id: defaultScope.id }
        : scope === 'documents'
          ? { type: 'documents', ids: [...selectedDocIds] }
          : { type: 'project' };
    setRunning(true);
    stopRef.current = false;
    setProgress({ done: 0, total: 0, name: null });
    try {
      const result = await runExport({
        client,
        project,
        preset,
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
      if (onClose) onClose();
      else setStep('preset');
    } catch (err) {
      if (err instanceof ExportCancelled) {
        notifyWarning('Export cancelled — nothing was downloaded.', 'Export');
      } else {
        console.error('Export failed:', err);
        notifyError(err?.message || 'Export failed — try again.', 'Export failed');
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const stepIndex = STEPS.indexOf(step);
  const canNext =
    step === 'preset'
      ? !!preset
      : step === 'options'
        ? true
        : scope !== 'documents' || selectedDocIds.size > 0;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Download className="h-4 w-4" /> Export
        <span className="text-sm font-normal text-muted-foreground">
          — {STEP_TITLES[step]}
          {preset && step !== 'preset' ? ` · ${preset.name}` : ''}
        </span>
      </h2>

      <div>
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
                ? `Document ${Math.min(progress.done + 1, progress.total)} of ${progress.total}${progress.name ? ` — ${progress.name}` : ''}`
                : 'Preparing…'}
            </span>
          </div>
        ) : (
          <>
            {step === 'preset' && (
              <PresetStep
                presets={presets}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onCreate={(format, name) => {
                  const p = newPreset(format, layers, name);
                  setPresets((prev) => [...prev, p]);
                  setSelectedId(p.id);
                  setDirty(true);
                }}
                onRename={(id, name) => {
                  setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
                  setDirty(true);
                }}
                onDelete={(id) => {
                  setPresets((prev) => prev.filter((p) => p.id !== id));
                  if (selectedId === id) setSelectedId(null);
                  setDirty(true);
                }}
              />
            )}
            {step === 'options' &&
              preset &&
              (preset.format === 'flextext' ? (
                <FlextextOptions
                  options={preset.options || {}}
                  layers={layers}
                  onChange={(options) => updatePreset({ options })}
                />
              ) : preset.format === 'plaid-igt-json' ? (
                <NativeOptions
                  options={preset.options || {}}
                  onChange={(options) => updatePreset({ options })}
                />
              ) : (
                <PlainTextOptions
                  options={preset.options || {}}
                  layers={layers}
                  onChange={(options) => updatePreset({ options })}
                />
              ))}
            {step === 'scope' && preset && (
              <ScopeStep
                scope={scope}
                onScopeChange={setScope}
                documents={docList}
                defaultDocument={defaultScope}
                historicalOnly={!!asOf}
                selectedDocIds={selectedDocIds}
                onSelectedDocIdsChange={setSelectedDocIds}
                includeVocabularies={preset.includeVocabularies}
                onIncludeVocabulariesChange={(v) => updatePreset({ includeVocabularies: v })}
                hasVocabularies={(project?.vocabs?.length ?? 0) > 0}
                vocabulariesForced={preset.format === 'plaid-igt-json'}
              />
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {dirty && !running && (
          <Button variant="ghost" className="mr-auto" onClick={() => persistPresets(presets)}>
            Save presets
          </Button>
        )}
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
            {stepIndex > 0 && (
              <Button variant="outline" onClick={() => setStep(STEPS[stepIndex - 1])}>
                Back
              </Button>
            )}
            {step !== 'scope' ? (
              <Button onClick={() => setStep(STEPS[stepIndex + 1])} disabled={!canNext}>
                Next
              </Button>
            ) : (
              <Button onClick={run} disabled={!canNext}>
                Export
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// Modal wrapper for the project page (DocumentList), where the wizard exports
// any set of the project's documents.
export const ExportDialog = ({ open, onOpenChange, ...wizardProps }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl">
      <DialogHeader className="sr-only">
        <DialogTitle>Export</DialogTitle>
      </DialogHeader>
      <ExportWizard active={open} onClose={() => onOpenChange(false)} {...wizardProps} />
    </DialogContent>
  </Dialog>
);
