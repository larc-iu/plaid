import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { LanguagesSettings } from './LanguagesSettings.jsx';
import { DocumentMetadataSettings } from './DocumentMetadataSettings.jsx';

// What the project IS: its name, the languages it documents, and the fields
// recorded about each text. Document Metadata sits here rather than with the
// annotation settings because Date and Speakers describe a text, not its
// interlinear structure.
export const GeneralSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const navigate = useNavigate();
  const [name, setName] = useState(project?.name ?? '');
  const [savingName, setSavingName] = useState(false);

  // Re-sync when the project reloads (including after our own rename), so the
  // field shows what the server has rather than a stale local edit.
  useEffect(() => {
    setName(project?.name ?? '');
  }, [project?.name]);

  const trimmedName = name.trim();
  const nameChanged = trimmedName !== (project?.name ?? '');
  const nameValid = trimmedName.length > 0;

  const handleRenameProject = async (event) => {
    event.preventDefault();
    if (!nameChanged || !nameValid || savingName) return;
    try {
      setSavingName(true);
      if (!client) throw new Error('Not authenticated');
      await client.projects.update(projectId, trimmedName);
      notifySuccess(`Project renamed to "${trimmedName}".`, 'Project updated');
      // The name shows in the breadcrumb, the project list and the delete
      // confirmation, so refresh the parent rather than only this field.
      onProjectUpdate?.();
    } catch (err) {
      console.error('Error renaming project:', err);
      notifyError('Failed to rename the project. Please try again.', 'Error');
      setName(project?.name ?? '');
    } finally {
      setSavingName(false);
    }
  };
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteProject = async () => {
    if (confirmationText.toLowerCase() !== project.name.toLowerCase()) {
      notifyError(
        'Project name does not match. Please type the exact project name.',
        'Invalid confirmation',
      );
      return;
    }

    try {
      setIsDeleting(true);
      if (!client) {
        throw new Error('Not authenticated');
      }
      await client.projects.delete(projectId);

      notifySuccess(`Project "${project.name}" has been successfully deleted.`, 'Project deleted');

      // Navigate back to projects list
      navigate('/projects');
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError('Failed to delete project. Please try again.', 'Error');
    } finally {
      setIsDeleting(false);
      setDeleteModalOpened(false);
    }
  };

  const handleDeleteClick = () => {
    setConfirmationText('');
    setDeleteModalOpened(true);
  };

  const isConfirmationValid = confirmationText.toLowerCase() === project.name.toLowerCase();

  return (
    <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
      {/* Project name */}
      <div>
        <h2 className="text-lg font-semibold">Project Name</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">
          Shown in the project list, the breadcrumb, and exports.
        </p>
        <form className="flex max-w-md flex-col gap-2" onSubmit={handleRenameProject}>
          <Label htmlFor="project-name" className="sr-only">
            Project name
          </Label>
          <div className="flex items-start gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={savingName}
                placeholder="Project name"
              />
              {nameChanged && !nameValid && (
                <p className="text-xs text-destructive">Project name cannot be empty</p>
              )}
            </div>
            <Button type="submit" disabled={!nameChanged || !nameValid || savingName}>
              {savingName ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </div>

      {/* Language identity */}
      <LanguagesSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />

      {/* Document Metadata Configuration */}
      <DocumentMetadataSettings projectId={projectId} client={client} />

      <div>
        <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">
          These actions are irreversible. Please proceed with caution.
        </p>

        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Delete Project</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Permanently delete this project and all of its documents, annotations, and associated
            data. This action cannot be undone.
          </p>
          <Button variant="destructive" className="self-start" onClick={handleDeleteClick}>
            <Trash2 className="h-4 w-4" /> Delete Project
          </Button>
        </div>
      </div>

      <Dialog open={deleteModalOpened} onOpenChange={setDeleteModalOpened}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">This action is irreversible</p>
                  <p className="mt-1 text-muted-foreground">
                    You are about to permanently delete the project{' '}
                    <strong>"{project.name}"</strong> and all of its associated data including
                    documents, annotations, and configuration.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm">
                To confirm deletion, please type the project name <strong>{project.name}</strong>{' '}
                below:
              </p>
              <Input
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                placeholder="Enter project name"
              />
              {confirmationText && !isConfirmationValid && (
                <p className="text-xs text-destructive">Project name does not match</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteModalOpened(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteProject}
              disabled={!isConfirmationValid || isDeleting}
            >
              <Trash2 className="h-4 w-4" /> {isDeleting ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
