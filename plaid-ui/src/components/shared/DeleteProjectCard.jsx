import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { humanizeError } from '../../lib/errors.js';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { DELETE_BUTTON_CLASS } from '../../lib/destructive.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.jsx';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

/**
 * The end of a project, at the foot of its General settings in every app: a
 * red-bordered card with an outline "Delete project" button, and a confirm
 * that asks for the project's name typed out. Enter in the name field
 * submits. The name is matched without regard to case or surrounding space.
 *
 * The server hides the project at once and removes it in the background, so
 * the request returns quickly and the reader lands on the project list.
 *
 * Props: `project` (with `id` and `name`).
 */
export const DeleteProjectCard = ({ project }) => {
  const { getClient } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);

  const matches = typed.trim().toLowerCase() === project.name.trim().toLowerCase();

  const openConfirm = () => {
    setTyped('');
    setOpen(true);
  };

  const handleDelete = async (event) => {
    // The dialog stays up, busy, until the server answers.
    event?.preventDefault();
    if (!matches || deleting) return;
    setDeleting(true);
    try {
      await getClient().projects.delete(project.id);
      notifySuccess(`Deleted “${project.name}”`);
      navigate(appRoutes().projects);
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError(humanizeError(err), 'Failed to delete project');
      setDeleting(false);
      setOpen(false);
    }
  };

  const consequence = (
    <>
      <strong className="text-foreground" dir="auto">
        {project.name}
      </strong>{' '}
      and all of its documents, annotations and settings are deleted. This cannot be undone.
    </>
  );

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-lg">Delete</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{consequence}</p>
        <Button
          variant="outline"
          className={`self-start ${DELETE_BUTTON_CLASS}`}
          onClick={openConfirm}
        >
          Delete project
        </Button>
      </CardContent>

      <ConfirmDeleteDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !deleting) setOpen(false);
        }}
        title="Delete project?"
        confirmLabel={deleting ? 'Deleting…' : 'Delete project'}
        confirmDisabled={!matches}
        busy={deleting}
        onConfirm={handleDelete}
      >
        <p>{consequence}</p>
        <div className="flex flex-col gap-1.5 text-foreground">
          <Label htmlFor="delete-project-confirm">
            To confirm, type{' '}
            <strong dir="auto" className="select-all">
              {project.name}
            </strong>
          </Label>
          <Input
            id="delete-project-confirm"
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
          {typed && !matches && (
            <p className="text-xs text-destructive">The name does not match.</p>
          )}
        </div>
      </ConfirmDeleteDialog>
    </Card>
  );
};
