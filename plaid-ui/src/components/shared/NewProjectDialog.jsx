import { useState } from 'react';
import { useAuth } from '../../contexts/useAuth.js';
import { humanizeError } from '../../lib/errors.js';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from '../ui/dialog';

/**
 * Name a project and make it. `create(client, name)` is the app's own setup
 * function, the same one its e2e fixture calls, and `children` is what that
 * setup will build, said in the app's words.
 *
 * The failure stays in the dialog rather than becoming a toast: the name is
 * still typed in the box behind it, and it is what has to be tried again.
 */
export const NewProjectDialog = ({ isOpen, onClose, onSuccess, title, create, children }) => {
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
      onSuccess(await create(getClient(), projectName));
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
          <DialogTitle>{title}</DialogTitle>
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
            {children}
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
