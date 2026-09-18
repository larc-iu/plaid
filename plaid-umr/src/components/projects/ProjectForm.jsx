import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { createUmrProject } from '../../domain/umrProjectSetup.js';
import { humanizeError } from '../../utils/feedback.jsx';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';

export const ProjectForm = ({ isOpen, onClose, onSuccess }) => {
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!projectName.trim()) {
      setError('Name the project.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const created = await createUmrProject(getClient(), projectName);
      onSuccess(created);
    } catch (err) {
      console.error('Error creating project:', err);
      setError(humanizeError(err, 'The project could not be created.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New UMR project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            <p>Layers created with the project:</p>
            <ul className="mt-2 list-disc pl-5">
              <li>Text layer</li>
              <li>Token layers: Sentences &rarr; Words</li>
              <li>UMR nodes, concepts, relations and document graph</li>
            </ul>
            <p className="mt-2">
              Documents come from .umr import. Text is edited in Plaid IGT or UD.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
