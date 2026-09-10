import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDocumentEditor } from '../editor/useDocumentEditor.js';
import { canEditProject } from '../../utils/permissions.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { fullTimestamp, timeAgo } from '../../utils/formatTime.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
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

// The document's own tab: what it is called, a copy of it, and the end of it.
// These three are here rather than scattered across the editor because they are
// all about the document as a thing, not about its text or its annotations.
// Delete in particular used to sit under the Text Editor's tokens, which put an
// irreversible action at the bottom of a screen people scroll through daily.
export const DocumentDetails = () => {
  const { projectId, documentId, doc, project } = useDocumentEditor();
  const { user, getClient } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();

  useDocumentTitle('Details', doc?.name, project?.name);

  const readOnly = !canEditProject(project, user);
  const [name, setName] = useState(doc.name || '');
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyName, setCopyName] = useState('');
  const [copying, setCopying] = useState(false);

  // Follow the document's own name whenever it changes underneath us (a rename
  // from another tab, or a reload). Keyed on the name alone, so typing here is
  // never stomped by an unrelated emit.
  useEffect(() => {
    setName(doc.name || '');
  }, [doc.name]);

  const dirty = name.trim() !== (doc.name || '') && name.trim() !== '';

  const handleRename = async () => {
    if (!dirty) return;
    if (await doc.rename(name)) notifySuccess('Document renamed');
  };

  const openCopy = () => {
    setCopyName(`${doc.name} (copy)`);
    setCopyOpen(true);
  };

  const handleCopy = async () => {
    setCopying(true);
    try {
      const created = await doc.copyTo(copyName);
      if (!created?.id) return;
      setCopyOpen(false);
      notifySuccess(`Copied to “${created.name}”`);
      navigate(`/projects/${projectId}/documents/${created.id}/edit`);
    } finally {
      setCopying(false);
    }
  };

  const handleDelete = async () => {
    const label = doc.name || 'this document';
    const ok = await confirm({
      title: `Delete “${label}”`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await getClient().documents.delete(documentId);
      notifySuccess(`Deleted “${label}”`);
      navigate(`/projects/${projectId}/documents`);
    } catch (err) {
      notifyError(err.message || 'Unknown error', 'Failed to delete document');
      console.error('Error deleting document:', err);
    }
  };

  const modified = doc.raw?.timeModified;

  return (
    <div className="tw mx-auto flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="document-name">Name</Label>
            <div className="flex items-end gap-2">
              <Input
                id="document-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                disabled={readOnly || doc.isSaving}
              />
              {!readOnly && (
                <Button onClick={handleRename} disabled={!dirty || doc.isSaving}>
                  Save
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="document-id">ID</Label>
            <Input id="document-id" value={documentId} readOnly disabled />
          </div>

          {modified && (
            <p className="text-xs text-muted-foreground" title={fullTimestamp(modified)}>
              Last changed {timeAgo(modified)}.
            </p>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Copy</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              The copy lands in this project with the same text, tokens and annotations. Comments do
              not travel.
            </p>
            <Button variant="outline" className="self-start" onClick={openCopy}>
              <Copy className="h-4 w-4" /> Copy document
            </Button>
          </CardContent>
        </Card>
      )}

      {!readOnly && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-xl">Delete</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              The document, its tokens and every annotation on it go. This cannot be undone.
            </p>
            <Button
              variant="outline"
              className="self-start text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" /> Delete document
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Copy document</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="copy-name">Name for the copy</Label>
            <Input
              id="copy-name"
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !copying && handleCopy()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyOpen(false)} disabled={copying}>
              Cancel
            </Button>
            <Button onClick={handleCopy} disabled={copying || !copyName.trim()}>
              {copying ? 'Copying…' : 'Copy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
