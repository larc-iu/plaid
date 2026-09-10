import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { UD_NAMESPACE, getUdLayerInfo, readProjectLanguage } from '../../utils/udLayerUtils.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useManagedProject } from './useManagedProject.js';
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

// "General": project-wide settings that aren't vocab or colors. The project's
// name, the language it annotates, the tokenizer locale the segmenter uses, and
// the destructive project delete, deliberately tucked behind a type-the-name
// confirmation since it is rarely needed.
//
// `onProjectUpdate` refreshes the parent's copy of the project. The name shows
// in the breadcrumb above this screen and in the project list, so a rename that
// only refreshed this tab would leave both stale until a reload.
export const ProjectGeneral = ({ onProjectUpdate }) => {
  const { projectId, project, loading, fetchProject, canConfigure } = useManagedProject();
  const navigate = useNavigate();
  const { getClient } = useAuth();

  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [language, setLanguage] = useState(''); // BCP-47, '' = not stated
  const [savingLocale, setSavingLocale] = useState(false);
  const [tokenizerLocale, setTokenizerLocale] = useState(''); // BCP-47, '' = the language

  // Delete (danger zone) — type-the-name-to-confirm.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Seed every editor from the server's copy, and re-seed whenever the project
  // reloads, so the form shows what is actually stored.
  useEffect(() => {
    if (!project) return;
    const info = getUdLayerInfo(project);
    setName(project.name || '');
    setLanguage(readProjectLanguage(project));
    setTokenizerLocale(info.textLayer?.config?.[UD_NAMESPACE]?.tokenizerLocale || '');
  }, [project]);

  const refresh = async () => {
    await fetchProject();
    onProjectUpdate?.();
  };

  const nameChanged = !!project && name.trim() !== project.name && name.trim() !== '';

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
      notifyError(err.message || 'Failed to rename the project.');
      setName(project?.name ?? '');
    } finally {
      setSavingName(false);
    }
  };

  // The language lives on the PROJECT, not a layer: it is a fact about the
  // project, and the parse spot reads it without loading layer config.
  const handleSaveLanguage = async () => {
    setSavingLanguage(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const tag = language.trim();
      if (tag) await client.projects.setConfig(projectId, UD_NAMESPACE, 'language', tag);
      else await client.projects.deleteConfig(projectId, UD_NAMESPACE, 'language');
      await fetchProject();
      notifySuccess('Language saved');
    } catch (err) {
      console.error('Failed to save project language:', err);
      notifyError(err.message || 'Failed to save the language.');
    } finally {
      setSavingLanguage(false);
    }
  };

  const handleSaveLocale = async () => {
    setSavingLocale(true);
    try {
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      const info = getUdLayerInfo(project);
      if (!info.textLayer) throw new Error('Project has no configured text layer.');
      const loc = tokenizerLocale.trim();
      if (loc)
        await client.textLayers.setConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale', loc);
      else await client.textLayers.deleteConfig(info.textLayer.id, UD_NAMESPACE, 'tokenizerLocale');
      await fetchProject();
      notifySuccess('Tokenizer locale saved');
    } catch (err) {
      console.error('Failed to save tokenizer locale:', err);
      notifyError(err.message || 'Failed to save tokenizer locale.');
    } finally {
      setSavingLocale(false);
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
      notifyError('Failed to delete project: ' + (err.message || 'Unknown error'));
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

  const info = getUdLayerInfo(project);

  return (
    <div className="tw flex flex-col gap-6">
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
            The language this project annotates, as a BCP-47 tag (<code>en</code>, <code>de</code>,{' '}
            <code>zh-Hans</code>). The parser starts on it, and tokenization uses it unless the
            locale below is set.
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tokenizer locale</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Language tag used for word tokenization (<code>Intl.Segmenter</code>). It drives
            script-specific segmentation, especially <code>ja</code>, <code>zh</code> and{' '}
            <code>th</code>, which are segmented by dictionary lookup when given the locale. Leave
            it empty to use the project language.
          </p>
          <p className="text-sm text-muted-foreground">
            <a
              className="underline underline-offset-4"
              href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter"
              target="_blank"
              rel="noreferrer"
            >
              Further information about <code>Intl.Segmenter</code>
            </a>
          </p>
          {info.textLayer ? (
            <div className="flex items-end gap-2">
              <Input
                value={tokenizerLocale}
                onChange={(e) => setTokenizerLocale(e.target.value)}
                placeholder={language.trim() || 'und'}
                className="w-56"
                spellCheck={false}
                aria-label="Tokenizer locale"
              />
              <Button onClick={handleSaveLocale} disabled={savingLocale}>
                {savingLocale ? 'Saving…' : 'Save'}
              </Button>
            </div>
          ) : (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Set up the project&apos;s UD layers before setting a tokenizer locale.
            </p>
          )}
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
