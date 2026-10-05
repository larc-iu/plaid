import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Switch } from '@ui/components/ui/switch';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readLanguages } from '@/domain/igtConfig';
import { readExportPresets, updateExportPresets, EXPORT_FORMATS } from '@/export/presets';
import { isConfigConflict, sameConfig } from '@ui/domain/configCells.js';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { PlainTextOptions } from '@/components/export/PlainTextOptions.jsx';
import { CldfOptions } from '@/components/export/CldfOptions.jsx';
import { FlextextOptions } from '@/components/export/FlextextOptions.jsx';
import { ElanOptions } from '@/components/export/ElanOptions.jsx';
import { NativeOptions } from '@/components/export/NativeOptions.jsx';
import { LatexOptions } from '@/components/export/LatexOptions.jsx';

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
  // A new value reads the preset again.
  const [reloads, setReloads] = useState(0);

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
  }, [client, projectId, presetId, reloads]);

  const layers = useMemo(() => (project ? discoverExportLayers(project) : null), [project]);
  const saved = presets?.find((p) => p.id === presetId) ?? null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const listUrl = `/projects/${projectId}/export`;

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    try {
      const edited = { ...draft, name: draft.name.trim() };
      // Only this preset is written. Another maintainer's save of the list
      // meanwhile stays, unless it changed or removed this preset, which
      // refuses the save.
      const stored = await updateExportPresets(client, project, (list) => {
        const now = list.find((p) => p.id === presetId);
        if (!sameConfig(now, saved)) {
          throw Object.assign(new Error('Changed elsewhere'), { status: 409 });
        }
        return list.map((p) => (p.id === presetId ? edited : p));
      });
      setPresets(stored.presets);
      setDraft(stored.presets.find((p) => p.id === presetId));
      // The page's own project object holds the presets too, and the runner
      // below reads the preset it runs out of THAT. Left stale, saving and
      // running in one sitting exported the settings from before the save.
      setProject(stored.project);
      // See ExportPresetsSettings: the containing page holds one as well.
      onProjectUpdate?.();
      notifySuccess(`Preset “${draft.name.trim()}” saved`);
    } catch (err) {
      console.error('Failed to save export preset:', err);
      notifyError(err, 'Failed to save the preset');
      // This preset changed or went meanwhile: show it as it is stored now.
      if (isConfigConflict(err)) setReloads((n) => n + 1);
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
      <div className="flex flex-col gap-4 pt-4">
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
    <div className="flex flex-col gap-6 pt-4">
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
        ) : draft.format === 'latex' ? (
          <LatexOptions
            options={draft.options || {}}
            layers={layers}
            vocabularies={project.vocabs || []}
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
        ) : draft.format === 'latex' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            A .zip of LaTeX source: main.tex with a table of contents, one chapter per document, and
            a list of abbreviations. It compiles with LuaLaTeX.
          </p>
        ) : draft.format === 'flextext' ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            One .flextext holding every document in the run. With the lexicon included it becomes a
            .zip: the .flextext, the .lift and its .lift-ranges.
          </p>
        ) : (
          hasVocabularies && (
            <label className="flex cursor-pointer items-center justify-between gap-2 border-t pt-3 text-sm">
              <span>
                <span className="font-medium">Include vocabularies as TSV files</span>
                <span className="block text-xs text-muted-foreground">
                  Added to the .zip that a project-wide or multi-document export produces.
                </span>
              </span>
              <Switch
                checked={!!draft.includeVocabularies}
                onCheckedChange={(v) => update({ includeVocabularies: v })}
              />
            </label>
          )
        )}
        {draft.format !== 'plaid-igt-json' && (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            Comments left on a document (the Comments tab) are not exported. A sentence field of
            your own named “Note” or “Comment” is a different thing and is exported like any other
            field.
          </p>
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
