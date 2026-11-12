import { Fragment, useEffect, useState } from 'react';
import { humanizeError, statusOf } from '../../lib/errors.js';
import { notifyError } from '../../lib/notify.js';
import { nameKey } from '../../lib/nameKey.js';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog.jsx';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

// How many other projects stand in the way of the delete, from core's 409
// (`other-projects`), or null for any other answer.
const borrowersOf = (error) => {
  const n = error?.responseData?.['other-projects'];
  return statusOf(error) === 409 && Number.isInteger(n) && n > 0 ? n : null;
};

const refusal = (n) =>
  n === 1
    ? '1 other project uses a vocabulary of this project. It can be deleted once that project unlinks it.'
    : `${n.toLocaleString()} other projects use a vocabulary of this project. It can be deleted once they unlink it.`;

// “A”, “A” and “B”, “A”, “B” and “C”.
const nameList = (vocabularies) =>
  vocabularies.map((v, i) => (
    <Fragment key={v.id}>
      {i === 0 ? '' : i === vocabularies.length - 1 ? ' and ' : ', '}
      {'“'}
      <span className="font-text text-foreground" dir="auto">
        {v.name}
      </span>
      {'”'}
    </Fragment>
  ));

/**
 * The confirm every project delete goes through. On open it asks core what
 * the delete would take (`projects.deletion(id)`, a read of its own, never the
 * delete) and Delete waits for the answer: the project's own vocabularies, named
 * after the consequence, since they are deleted with it, or core's refusal
 * while another project links one of them, which replaces the confirm (no
 * name to type, Cancel only). It asks for the project's name typed out,
 * matched without regard to case or surrounding space, and Enter in the name
 * field submits. The dialog stays up, busy, until `onDelete` answers. A throw
 * is reported and closes it, except the same refusal, which it then shows.
 *
 * Props: `open`, `onOpenChange`, `project` (with `id` and `name`), `client`
 * (asks what the delete takes; without it the confirm names no vocabulary and waits for
 * nothing), `consequence` (what the delete takes, as a node) and `onDelete`
 * (async, does the delete).
 */
export const DeleteProjectDialog = ({
  open,
  onOpenChange,
  project,
  client,
  consequence,
  onDelete,
}) => {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  // What core said the delete takes: null while it is asked, then `{ vocabularies }` or
  // `{ borrowers }`. `{}` when there is none to ask or it failed, which lets
  // the delete go ahead and core judge it.
  const [preview, setPreview] = useState(null);
  const name = project?.name ?? '';
  const projectId = project?.id;
  const matches = nameKey(typed).trim().toLowerCase() === nameKey(name).trim().toLowerCase();
  // Empty every time it opens, whoever opens it: a name typed before a Cancel
  // must not leave the delete armed.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    if (!client || !projectId) {
      setPreview({});
      return undefined;
    }
    let alive = true;
    setPreview(null);
    client.projects
      .deletion(projectId)
      .then((answer) => alive && setPreview({ vocabularies: answer?.vocabularies || [] }))
      .catch((err) => {
        if (!alive) return;
        const borrowers = borrowersOf(err);
        if (borrowers) setPreview({ borrowers });
        else {
          console.error('Could not ask what deleting the project takes:', err);
          setPreview({});
        }
      });
    return () => {
      alive = false;
    };
  }, [open, client, projectId]);

  const ready = preview !== null;
  const refused = preview?.borrowers ?? null;

  const handleDelete = async (event) => {
    event?.preventDefault();
    if (!matches || deleting || !ready || refused) return;
    setDeleting(true);
    try {
      await onDelete();
    } catch (err) {
      const borrowers = borrowersOf(err);
      if (borrowers) {
        setPreview({ borrowers });
      } else {
        console.error('Error deleting project:', err);
        notifyError(humanizeError(err), 'Failed to delete project');
        onOpenChange(false);
      }
    } finally {
      setDeleting(false);
    }
  };

  const vocabularies = preview?.vocabularies || [];
  const description = refused ? (
    refusal(refused)
  ) : vocabularies.length ? (
    <>
      {consequence} {vocabularies.length === 1 ? 'Its vocabulary ' : 'Its vocabularies '}
      {nameList(vocabularies)}
      {vocabularies.length === 1 ? ' is deleted with it.' : ' are deleted with it.'}
    </>
  ) : (
    consequence
  );

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next);
      }}
      title="Delete project?"
      confirmLabel={deleting ? 'Deleting…' : 'Delete project'}
      confirmDisabled={!matches || !ready}
      busy={deleting}
      onConfirm={handleDelete}
      cancelOnly={!!refused}
      description={description}
    >
      {refused ? null : (
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
          {typed && !matches && (
            <p className="text-xs text-destructive">The name does not match.</p>
          )}
        </div>
      )}
    </ConfirmDeleteDialog>
  );
};
