import { useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { notifyError, notifySuccess, humanizeError } from '@/utils/feedback';

/**
 * What a project whose import did not finish shows in place of itself
 * (config.igt.import, see `readImportState`): the project list's door, a
 * link to the project or one of its documents, and the import page once its
 * run stops. Such a project is only ever deleted, by a maintainer and only on
 * request: an import may still be running in another tab.
 *
 * `project` is `{id, name}`. `onDeleted` runs once the project is gone.
 */
export const UnfinishedImport = ({ client, project, canManage, onDeleted }) => {
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete project?',
      description: `“${project.name ?? 'This project'}” and everything in it are deleted.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await client.projects.delete(project.id);
      notifySuccess(`Deleted “${project.name ?? 'the project'}”`);
      onDeleted?.();
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError(humanizeError(err), 'Failed to delete project');
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <p>
        This import did not finish.{' '}
        {canManage ? 'Delete it and import again.' : 'A project maintainer can delete it.'}
      </p>
      {canManage && (
        <Button
          variant="outline"
          size="sm"
          className={DELETE_BUTTON_CLASS}
          onClick={remove}
          disabled={deleting}
        >
          Delete
        </Button>
      )}
    </div>
  );
};
