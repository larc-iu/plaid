import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readExportPresets, writeExportPresets, newPreset } from '@/export/presets';
import { PresetStep } from '@/components/export/PresetStep.jsx';
import { PlainTextOptions } from '@/components/export/PlainTextOptions.jsx';
import { FlextextOptions } from '@/components/export/FlextextOptions.jsx';
import { NativeOptions } from '@/components/export/NativeOptions.jsx';

// Settings → Export: the project's named export presets (format + layers +
// format options), persisted at config.igt.export.presets. Exporting itself
// happens from a document's Export tab or the project page's Export button,
// which only pick one of these.
export const ExportPresetsSettings = ({ projectId, client }) => {
  const [project, setProject] = useState(null);
  const [hasError, setHasError] = useState(false);
  const [presets, setPresets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setHasError(false);
      const p = await client.projects.get(projectId);
      setProject(p);
      const initial = readExportPresets(p).map((x) => JSON.parse(JSON.stringify(x)));
      setPresets(initial);
      setSelectedId(initial[0]?.id ?? null);
      setDirty(false);
    } catch (err) {
      console.error('Failed to load export presets:', err);
      setHasError(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const layers = useMemo(() => (project ? discoverExportLayers(project) : null), [project]);
  const preset = presets.find((p) => p.id === selectedId) ?? null;

  const updatePreset = (patch) => {
    setPresets((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await writeExportPresets(client, projectId, presets);
      setDirty(false);
      notifySuccess('Export presets saved.', 'Presets saved');
    } catch (err) {
      console.error('Failed to save export presets:', err);
      notifyError('Saving export presets failed. Try again.', 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (hasError) {
    return (
      <div className="tw pt-4">
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> Could not load the export presets.
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!project || !layers) return null;

  const hasVocabularies = (project.vocabs?.length ?? 0) > 0;

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Export Presets</h2>
              <p className="text-sm text-muted-foreground">
                A preset fixes an export format and which orthographies, fields and options it
                includes. Documents and the project page export with one of these.
              </p>
            </div>
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>

          <div className="border-t" />

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
        </div>
      </div>

      {preset && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Options — {preset.name}</h2>
              <p className="text-sm text-muted-foreground">
                What this preset includes when it runs.
              </p>
            </div>
            <div className="border-t" />
            {preset.format === 'flextext' ? (
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
            )}
            {preset.format === 'plaid-igt-json' ? (
              <p className="border-t pt-3 text-xs text-muted-foreground">
                This format always produces a .zip archive including all vocabularies and the
                project configuration.
              </p>
            ) : (
              hasVocabularies && (
                <label className="flex cursor-pointer items-center justify-between gap-2 border-t pt-3 text-sm">
                  <span>
                    <Label className="cursor-pointer">Include vocabularies as TSV files</Label>
                    <span className="block text-xs text-muted-foreground">
                      Applies to project-wide and multi-document exports, which produce a .zip.
                    </span>
                  </span>
                  <Switch
                    checked={!!preset.includeVocabularies}
                    onCheckedChange={(v) => updatePreset({ includeVocabularies: v })}
                  />
                </label>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};
