import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, AlertTriangle } from 'lucide-react';
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
import { DocumentMetadataSettings } from './settings/DocumentMetadataSettings.jsx';
import { OrthographiesSettings } from './settings/OrthographiesSettings.jsx';
import { FieldsSettings } from './settings/FieldsSettings.jsx';
import { VocabularySettings } from './settings/VocabularySettings.jsx';

export const ProjectSettings = ({ project, projectId, client }) => {
  const navigate = useNavigate();
  const [deleteModalOpened, setDeleteModalOpened] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteProject = async () => {
    if (confirmationText.toLowerCase() !== project.name.toLowerCase()) {
      notifyError('Project name does not match. Please type the exact project name.', 'Invalid confirmation');
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
    <div className="tw flex flex-col gap-6 pt-4">
      {/* Document Metadata Configuration */}
      <DocumentMetadataSettings projectId={projectId} client={client} />

      {/* Orthographies Configuration */}
      <OrthographiesSettings projectId={projectId} client={client} />

      {/* Fields Configuration */}
      <FieldsSettings projectId={projectId} client={client} />

      {/* Vocabulary Configuration */}
      <VocabularySettings projectId={projectId} client={client} />

      <div className="rounded-lg border border-destructive/40 p-4">
        <h2 className="text-lg font-semibold">Danger Zone</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">
          These actions are irreversible. Please proceed with caution.
        </p>

        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Delete Project</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Permanently delete this project and all of its documents, annotations, and associated data.
            This action cannot be undone.
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
                    You are about to permanently delete the project <strong>"{project.name}"</strong> and
                    all of its associated data including documents, annotations, and configuration.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm">
                To confirm deletion, please type the project name <strong>{project.name}</strong> below:
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
            <Button variant="outline" onClick={() => setDeleteModalOpened(false)} disabled={isDeleting}>
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
