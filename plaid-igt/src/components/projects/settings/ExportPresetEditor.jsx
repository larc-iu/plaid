import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/contexts/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readExportPresets, writeExportPresets, EXPORT_FORMATS } from '@/export/presets';
import { PlainTextOptions } from '@/components/export/PlainTextOptions.jsx';
import { FlextextOptions } from '@/components/export/FlextextOptions.jsx';
import { NativeOptions } from '@/components/export/NativeOptions.jsx';

const formatLabel = (id) => EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id;

// Full-page editor for ONE export preset (/projects/:projectId/export/:presetId).
// Name and options are edited here; the format is fixed at creation. Saving
// rewrites the project's whole preset list (config.igt.export.presets).
export const ExportPresetEditor = () => {
  const { projectId, presetId } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { user, client, logout } = useAuth();
  const [project, setProject] = useState(null);
  const [presets, setPresets] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!client) throw new Error('Not authenticated');
        const p = await client.projects.get(projectId);
        if (cancelled) return;
        const list = readExportPresets(p);
        const found = list.find((x) => x.id === presetId) ?? null;
        setProject(p);
        setPresets(list);
        setDraft(found ? JSON.parse(JSON.stringify(found)) : null);
        setError(found ? '' : 'This export preset no longer exists.');
      } catch (err) {
        if (err.message === 'Not authenticated' || err.status === 401) {
          logout();
          return;
        }
        console.error('Failed to load export preset:', err);
        if (!cancelled) setError('Failed to load the export preset.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, presetId]);

  useDocumentTitle(draft ? `${draft.name} · Export · ${project?.name ?? 'Project'}` : null);

  const layers = useMemo(() => (project ? discoverExportLayers(project) : null), [project]);
  const saved = presets?.find((p) => p.id === presetId) ?? null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  const canManage = !!user && !!project && (user.isAdmin || project.maintainers?.includes(user.id));
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

  if (error || (project && !canManage)) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error || 'Only project maintainers can edit export presets.'}
        </div>
        <Button variant="outline" className="mt-4" onClick={() => navigate(listUrl)}>
          <ArrowLeft className="h-4 w-4" /> Back to export presets
        </Button>
      </div>
    );
  }
  if (!project || !draft || !layers) return null;

  const hasVocabularies = (project.vocabs?.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="tw flex flex-col gap-6">
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground">
            Projects
          </Link>
          <span>/</span>
          <Link to={`/projects/${projectId}`} className="hover:text-foreground">
            {project.name}
          </Link>
          <span>/</span>
          <Link to={listUrl} className="hover:text-foreground">
            Export presets
          </Link>
          <span>/</span>
          <span className="text-foreground">{saved?.name ?? draft.name}</span>
        </nav>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={back}
              aria-label="Back to export presets"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{saved?.name ?? draft.name}</h1>
              <p className="text-sm text-muted-foreground">{formatLabel(draft.format)}</p>
            </div>
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

        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="max-w-md"
              />
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Contents</h2>
              <p className="text-sm text-muted-foreground">
                What this preset includes when it runs.
              </p>
            </div>
            <div className="border-t" />
            {draft.format === 'flextext' ? (
              <FlextextOptions
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
                This format always produces a .zip archive including all vocabularies and the
                project configuration.
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
        </div>
      </div>
    </div>
  );
};
