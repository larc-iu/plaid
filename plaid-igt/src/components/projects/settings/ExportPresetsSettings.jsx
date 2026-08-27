import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { discoverExportLayers } from '@/export/exportLayers';
import { readExportPresets, writeExportPresets, newPreset, EXPORT_FORMATS } from '@/export/presets';

const formatLabel = (id) => EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id;

// Settings → Export: the project's named export presets, persisted at
// config.igt.export.presets. This is the list: create (modal), delete, and a
// link per preset to its own editor page (ExportPresetEditor,
// /projects/:id/export/:presetId). Exporting itself happens from a document's
// Export tab or the project page's Export button, which only pick one.
export const ExportPresetsSettings = ({ projectId, client }) => {
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [hasError, setHasError] = useState(false);
  const [presets, setPresets] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFormat, setNewFormat] = useState('plaintext');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    try {
      setHasError(false);
      const p = await client.projects.get(projectId);
      setProject(p);
      setPresets(readExportPresets(p));
    } catch (err) {
      console.error('Failed to load export presets:', err);
      setHasError(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const persist = async (next, successMessage) => {
    await writeExportPresets(client, projectId, next);
    setPresets(next);
    if (successMessage) notifySuccess(successMessage, 'Export presets');
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || !project) return;
    setCreating(true);
    try {
      const preset = newPreset(newFormat, discoverExportLayers(project), name);
      await persist([...presets, preset]);
      setCreateOpen(false);
      setNewName('');
      navigate(`/projects/${projectId}/export/${preset.id}`);
    } catch (err) {
      console.error('Failed to create export preset:', err);
      notifyError('Creating the preset failed. Try again.', 'Export presets');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id) => {
    const target = presets.find((p) => p.id === id);
    try {
      await persist(
        presets.filter((p) => p.id !== id),
        `Deleted preset “${target?.name}”.`,
      );
    } catch (err) {
      console.error('Failed to delete export preset:', err);
      notifyError('Deleting the preset failed. Try again.', 'Export presets');
    } finally {
      setDeletingId(null);
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
  if (!project) return null;

  const deleting = presets.find((p) => p.id === deletingId);

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
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New preset
            </Button>
          </div>

          <div className="border-t" />

          {presets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No export presets yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {presets.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <Link
                    to={`/projects/${projectId}/export/${p.id}`}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{formatLabel(p.format)}</span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => setDeletingId(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New export preset</DialogTitle>
            <DialogDescription>
              Pick a name and a format. You will configure what it includes next.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-preset-name">Name</Label>
              <Input
                id="new-preset-name"
                placeholder="e.g. Plain text for the course"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                }}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-preset-format">Format</Label>
              <Select value={newFormat} onValueChange={setNewFormat}>
                <SelectTrigger id="new-preset-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPORT_FORMATS.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={create} disabled={!newName.trim() || creating}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deletingId}
        onOpenChange={(o) => {
          if (!o) setDeletingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}” will be removed from this project’s export presets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove(deletingId)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
