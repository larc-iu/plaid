import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { notifySuccess } from '../../lib/notify.js';
import { DELETE_BUTTON_CLASS } from '../../lib/destructive.js';
import { DeleteProjectDialog } from './DeleteProjectDialog.jsx';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

/**
 * The end of a project, at the foot of its General settings in every app: a
 * red-bordered card with an outline "Delete project" button, and the confirm
 * that asks for the project's name typed out (DeleteProjectDialog). The
 * confirm names the project's own vocabularies, which go with it, or says
 * why it cannot be deleted while another project uses one of them.
 *
 * The server hides the project at once and removes it in the background, so
 * the request returns quickly and the reader lands on the project list.
 *
 * Props: `project` (with `id` and `name`), and `note`, more of what the
 * delete means that the app knows of its own data (a node of inline text),
 * which the confirm says after the consequence.
 */
export const DeleteProjectCard = ({ project, note = null }) => {
  const { client, getClient } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const consequence = (
    <>
      <strong className="font-text text-foreground" dir="auto">
        {project.name}
      </strong>{' '}
      and all of its documents, annotations and settings are deleted. This cannot be undone.
    </>
  );

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{consequence}</p>
        <Button
          variant="outline"
          className={`self-start ${DELETE_BUTTON_CLASS}`}
          onClick={() => setOpen(true)}
        >
          Delete project
        </Button>
      </CardContent>

      <DeleteProjectDialog
        open={open}
        onOpenChange={setOpen}
        project={project}
        client={client}
        consequence={
          note ? (
            <>
              {consequence} {note}
            </>
          ) : (
            consequence
          )
        }
        onDelete={async () => {
          await getClient().projects.delete(project.id);
          notifySuccess(`Deleted “${project.name}”`);
          navigate(appRoutes().projects);
        }}
      />
    </Card>
  );
};
