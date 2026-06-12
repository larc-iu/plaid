import { useState } from 'react';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { EXPORT_FORMATS } from '@/export/presets';

const formatLabel = (id) => EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id;

// Step 1: pick (or create/rename/delete) a named preset.
export const PresetStep = ({ presets, selectedId, onSelect, onCreate, onRename, onDelete }) => {
  const [newName, setNewName] = useState('');
  const [newFormat, setNewFormat] = useState('plaintext');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(newFormat, name);
    setNewName('');
  };

  const commitRename = () => {
    const name = renameValue.trim();
    if (name) onRename(renamingId, name);
    setRenamingId(null);
  };

  const deleting = presets.find((p) => p.id === deletingId);

  return (
    <div className="flex flex-col gap-4">
      {presets.length > 0 ? (
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {presets.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                p.id === selectedId ? 'border-primary bg-accent/40' : 'hover:bg-muted/50'
              }`}
            >
              {renamingId === p.id ? (
                <>
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    className="h-7 flex-1"
                    autoFocus
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={commitRename} aria-label="Confirm rename">
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRenamingId(null)} aria-label="Cancel rename">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <button type="button" className="flex flex-1 items-center gap-2 text-left" onClick={() => onSelect(p.id)}>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{formatLabel(p.format)}</span>
                  </button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7" aria-label={`Rename ${p.name}`}
                    onClick={() => { setRenamingId(p.id); setRenameValue(p.name); }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7" aria-label={`Delete ${p.name}`}
                    onClick={() => setDeletingId(p.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No export presets yet — create one below. Presets remember your format
          and layer choices for next time.
        </p>
      )}

      <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 p-3">
        <Label htmlFor="new-preset-name">New preset</Label>
        <div className="flex items-center gap-2">
          <Input
            id="new-preset-name"
            placeholder="Preset name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            className="flex-1"
          />
          <Select value={newFormat} onValueChange={setNewFormat}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EXPORT_FORMATS.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={create} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" /> Create
          </Button>
        </div>
      </div>

      <AlertDialog open={!!deletingId} onOpenChange={(o) => { if (!o) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete preset?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}” will be removed from this project’s saved export presets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onDelete(deletingId); setDeletingId(null); }}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
