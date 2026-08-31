import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readLanguages } from '@/domain/igtConfig';
import { readExportPresets, writeExportPresets, EXPORT_FORMATS } from '@/export/presets';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { PlainTextOptions } from '@/components/export/PlainTextOptions.jsx';
import { CldfOptions } from '@/components/export/CldfOptions.jsx';
import { FlextextOptions } from '@/components/export/FlextextOptions.jsx';
import { ElanOptions } from '@/components/export/ElanOptions.jsx';
import { NativeOptions } from '@/components/export/NativeOptions.jsx';

const formatLabel = (id) => EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id;

// The project's Export tab → one preset (/projects/:projectId/export/:presetId).
// Rendered in place of the preset list inside the Settings section, so the
// project's tab structure stays put. Name and options are edited here; the
// format is fixed at creation. Saving rewrites the project's whole preset list
// (config.igt.export.presets).
export const ExportPresetEditor = ({ projectId, client, presetId, onProjectUpdate }) => {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [project, setProject] = useState(null);
  const [presets, setPresets] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await client.projects.get(projectId);
        if (cancelled) return;
        const list = readExportPresets(p);
        const found = list.find((x) => x.id === presetId) ?? null;
        setProject(p);
        setPresets(list);
        setDraft(found ? JSON.parse(JSON.stringify(found)) : null);
        setError(found ? '' : 'This export preset no longer exists.');
      } catch (err) {
        console.error('Failed to load export preset:', err);
        if (!cancelled) setError('Failed to load the export preset.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, presetId]);

  const layers = useMemo(() => (project ? discoverExportLayers(project) : null), [project]);
  const saved = presets?.find((p) => p.id === presetId) ?? null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const listUrl = `/projects/${projectId}/export`;

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    try {
      const next = presets.map((p) =>
        p.id === presetId ? { ...draft, name: draft.name.trim() } : p,
      );
      await writeExportPresets(client, projectId, next);
      setPresets(next);
      setDraft(next.find((p) => p.id === presetId));
      // See ExportPresetsSettings: the page's project object holds the presets
      // and goes stale on every write.
      onProjectUpdate?.();
      notifySuccess(`Saved preset “${draft.name.trim()}”.`, 'Export presets');
    } catch (err) {
      console.error('Failed to save export preset:', err);
      notifyError('Saving the preset failed. Try again.', 'Export presets');
    } finally {
      setSaving(false);
    }
  };

  const back = async () => {
    if (
      dirty &&
      !(await confirm({
        title: 'Discard changes?',
        description: 'This preset has unsaved changes.',
        confirmLabel: 'Discard',
        destructive: true,
      }))
    ) {
      return;
    }
    navigate(listUrl);
  };

  const backButton = (
    <Button variant="ghost" size="sm" className="-ml-2" onClick={back}>
      <ArrowLeft className="h-4 w-4" /> Back to export presets
    </Button>
  );

  if (error) {
    return (
      <div className="tw flex flex-col gap-4 pt-4">
        <div>{backButton}</div>
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      </div>
    );
  }
  if (!project || !draft || !layers) return null;

  const hasVocabularies = (project.vocabs?.length ?? 0) > 0;

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="flex flex-col gap-3">
        <div>{backButton}</div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{saved?.name ?? draft.name}</h2>
            <p className="text-sm text-muted-foreground">{formatLabel(draft.format)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={back}>
              {dirty ? 'Cancel' : 'Done'}
            </Button>
            <Button onClick={save} disabled={!dirty || saving || !draft.name.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="preset-name">Name</Label>
        <Input
          id="preset-name"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          className="max-w-md"
        />
      </div>

      <div className="flex flex-col gap-4 border-t pt-4">
        <div>
          <h3 className="text-lg font-semibold">Contents</h3>
          <p className="text-sm text-muted-foreground">What this preset includes when it runs.</p>
        </div>
        {draft.format === 'flextext' ? (
          <FlextextOptions
            options={draft.options || {}}
            layers={layers}
            onChange={(options) => update({ options })}
          />
        ) : draft.format === 'cldf' ? (
          <CldfOptions
            options={draft.options || {}}
            layers={layers}
            languages={readLanguages(project.config)}
            projectId={projectId}
            onChange={(options) => update({ options })}
          />
        ) : draft.format === 'elan' ? (
          <ElanOptions
            options={draft.options || {}}
            layers={layers}
            onChange={(options) => update({ options })}
          />
        ) : draft.format === 'plaid-igt-json' ? (
          <NativeOptions
            options={draft.options || {}}
            onChange={(options) => update({ options })}
          />
        ) : (
          <PlainTextOptions
            options={draft.options || {}}
            layers={layers}
            onChange={(options) => update({ options })}
          />
        )}
        {draft.format === 'plaid-igt-json' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            This format always produces a .zip archive including all vocabularies and the project
            configuration.
          </p>
        ) : draft.format === 'cldf' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            This format always produces a .zip dataset: one CSV per CLDF component table, described
            by a cldf-metadata.json.
          </p>
        ) : draft.format === 'elan' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            One .eaf per document. A document with media is bundled into a .zip alongside it, so the
            file ELAN opens finds its recording.
          </p>
        ) : draft.format === 'flextext' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            One .flextext holding every document in the run. With the lexicon included it becomes a
            .zip: the .flextext, the .lift and its .lift-ranges, and a README giving the order FLEx
            needs them imported in.
          </p>
        ) : (
          hasVocabularies && (
            <label className="flex cursor-pointer items-center justify-between gap-2 border-t pt-3 text-sm">
              <span>
                <span className="font-medium">Include vocabularies as TSV files</span>
                <span className="block text-xs text-muted-foreground">
                  Applies to project-wide and multi-document exports, which produce a .zip.
                </span>
              </span>
              <Switch
                checked={!!draft.includeVocabularies}
                onCheckedChange={(v) => update({ includeVocabularies: v })}
              />
            </label>
          )
        )}
      </div>

      <div className="rounded-md border bg-muted/20 p-4">
        {dirty ? (
          <p className="text-sm text-muted-foreground">
            Save this preset to run it. An export always uses the saved settings, not the unsaved
            ones on screen.
          </p>
        ) : (
          <ExportRunner
            client={client}
            project={project}
            canManage
            presetId={presetId}
            showPresetsLink={false}
          />
        )}
      </div>
    </div>
  );
};
