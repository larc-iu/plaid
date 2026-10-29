import { useEffect, useState } from 'react';
import { humanizeError } from '../../lib/errors.js';
import { notifyError } from '../../lib/notify.js';
import { nameKey } from '../../lib/nameKey.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.jsx';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/**
 * The confirm every project delete goes through: it asks for the project's
 * name typed out, matched without regard to case or surrounding space, and
 * Enter in the name field submits. The dialog stays up, busy, until
 * `onDelete` answers. A throw is reported and closes it.
 *
 * Props: `open`, `onOpenChange`, `project` (with `name`), `consequence` (what
 * the delete takes, as a node) and `onDelete` (async, does the delete).
 */
export const DeleteProjectDialog = ({ open, onOpenChange, project, consequence, onDelete }) => {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const name = project?.name ?? '';
  const matches = nameKey(typed).trim().toLowerCase() === nameKey(name).trim().toLowerCase();
  // Empty every time it opens, whoever opens it: a name typed before a Cancel
  // must not leave the delete armed.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const handleDelete = async (event) => {
    event?.preventDefault();
    if (!matches || deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError(humanizeError(err), 'Failed to delete project');
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next);
      }}
      title="Delete project?"
      confirmLabel={deleting ? 'Deleting…' : 'Delete project'}
      confirmDisabled={!matches}
      busy={deleting}
      onConfirm={handleDelete}
      description={consequence}
    >
      <div className="flex flex-col gap-1.5 text-foreground">
        <Label htmlFor="delete-project-confirm">
          To confirm, type{' '}
          <strong dir="auto" className="select-all font-text">
            {name}
          </strong>
        </Label>
        <Input
          id="delete-project-confirm"
          className="font-text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleDelete(e);
          }}
          disabled={deleting}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        {typed && !matches && <p className="text-xs text-destructive">The name does not match.</p>}
      </div>
    </ConfirmDeleteDialog>
  );
};
