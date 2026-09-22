import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UMR_NAMESPACE, readProjectLanguage } from '../../utils/umrLayerUtils.js';
import { FRAME_LANGUAGES, framesFor } from '../../domain/lexicon.js';

// The languages with a bundled frame file, for the line that says a project's
// has none. Named rather than listed as tags: a tag is what you type, a name
// is what you recognize.
const BUNDLED_NAMES = Object.values(FRAME_LANGUAGES)
  .map((f) => f.name)
  .join(', ');
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';

// "General": the project's name, the language it annotates, and its deletion.
// tucked behind a type-the-name confirmation since it is rarely needed.
//
// `onProjectUpdate` refreshes the parent's copy of the project. The name shows
// in the breadcrumb above this screen and in the project list, so a rename that
// only refreshed this tab would leave both stale until a reload.
export const ProjectGeneralSettings = ({ onProjectUpdate }) => {
  const { projectId, project, loading, fetchProject, canConfigure } = useManagedProject();
  const navigate = useNavigate();
  const { getClient } = useAuth();

  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [language, setLanguage] = useState(''); // BCP-47, '' = not stated

  // Delete (danger zone), type-the-name-to-confirm.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Seed every editor from the server's copy, and re-seed whenever the project
  // reloads, so the form shows what is actually stored.
  useEffect(() => {
    if (!project) return;
    setName(project.name || '');
    setLanguage(readProjectLanguage(project));
  }, [project]);

  const refresh = async () => {
    await fetchProject();
    onProjectUpdate?.();
  };

  const nameChanged = !!project && name.trim() !== project.name && name.trim() !== '';

  // The language as SAVED, not as typed: the line below reports what the
  // concept editor is offering now, which an unsaved edit has not changed.
  const savedLanguage = project ? readProjectLanguage(project) : '';
  const savedFrames = framesFor(savedLanguage);

  const handleRename = async () => {
    if (!nameChanged) return;
    setSavingName(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      await client.projects.update(projectId, name.trim());
      await refresh();
      notifySuccess('Project renamed');
    } catch (err) {
      console.error('Error renaming project:', err);
      notifyError(humanizeError(err, 'Failed to rename the project.'));
      setName(project?.name ?? '');
    } finally {
      setSavingName(false);
    }
  };

  // The language lives on the PROJECT, not a layer: it is a fact about the
  // project, and it picks the frame file the concept editor reads.
  const handleSaveLanguage = async () => {
    setSavingLanguage(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const tag = language.trim();
      if (tag) await client.projects.setConfig(projectId, UMR_NAMESPACE, 'language', tag);
      else await client.projects.deleteConfig(projectId, UMR_NAMESPACE, 'language');
      await fetchProject();
      notifySuccess('Language saved');
    } catch (err) {
      console.error('Failed to save project language:', err);
      notifyError(humanizeError(err, 'Failed to save the language.'));
    } finally {
      setSavingLanguage(false);
    }
  };

  const isDeleteConfirmValid =
    !!project && deleteConfirmText.trim().toLowerCase() === project.name.toLowerCase();

  const handleDeleteProject = async () => {
    if (!isDeleteConfirmValid) return;
    try {
      setIsDeleting(true);
      await getClient().projects.delete(projectId);
      notifySuccess(`Deleted “${project.name}”`);
      navigate('/projects');
    } catch (err) {
      console.error('Error deleting project:', err);
      notifyError(humanizeError(err), 'Failed to delete project');
      setIsDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!project || !canConfigure) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Name</CardTitle>
        </CardHeader>
        <CardContent className="flex max-w-md items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="project-name" className="sr-only">
              Project name
            </Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
              disabled={savingName}
            />
          </div>
          <Button onClick={handleRename} disabled={!nameChanged || savingName}>
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Language</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The language this project annotates, as a BCP-47 tag (<code>en</code>, <code>zh</code>,{' '}
            <code>arp</code>). It picks the rolesets the concept editor offers, and it is the
            language code on an exported document.
          </p>
          <div className="flex items-end gap-2">
            <Input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="en"
              className="w-56"
              spellCheck={false}
              aria-label="Project language"
            />
            <Button onClick={handleSaveLanguage} disabled={savingLanguage}>
              {savingLanguage ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {/* Which rolesets the saved language actually gets. Four languages
              have a bundled file and every other one has none, which the
              concept editor showed only as an empty Senses group. */}
          <p className="text-sm text-muted-foreground">
            {savedFrames ? (
              <>
                Bundled rolesets: {savedFrames.name}, {savedFrames.rolesets.toLocaleString()}.
              </>
            ) : savedLanguage ? (
              <>
                No bundled rolesets for <code>{savedLanguage}</code>. Rolesets come from the
                project&rsquo;s vocabularies, written on an entry in Plaid IGT. Bundled:{' '}
                {BUNDLED_NAMES}.
              </>
            ) : (
              <>No language, so no bundled rolesets. Bundled: {BUNDLED_NAMES}.</>
            )}
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-lg">Delete</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            <strong>{project.name}</strong> and all of its documents, annotations and configuration
            go. This cannot be undone.
          </p>
          <Button
            variant="outline"
            className="self-start text-destructive"
            onClick={() => {
              setDeleteConfirmText('');
              setDeleteOpen(true);
            }}
          >
            Delete project
          </Button>
        </CardContent>
      </Card>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeleteOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
          </DialogHeader>
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <strong>{project.name}</strong> and all of its documents, annotations and configuration
            go. This cannot be undone.
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm">
              To confirm, type <strong>{project.name}</strong>
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isDeleteConfirmValid) handleDeleteProject();
              }}
              autoFocus
              spellCheck={false}
            />
            {deleteConfirmText && !isDeleteConfirmValid && (
              <p className="text-xs text-destructive">The name does not match.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteProject}
              disabled={!isDeleteConfirmValid || isDeleting}
            >
              {isDeleting ? 'Deleting…' : 'Delete project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
