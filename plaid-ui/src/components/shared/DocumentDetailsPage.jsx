import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentEditor } from '../../hooks/useDocumentEditor.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import {
  useUnsavedDraft,
  useUnsavedGuard,
  dropUnsavedDrafts,
} from '../../hooks/useUnsavedDraft.js';
import { canEditProject } from '../../domain/permissions.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { humanizeError } from '../../lib/errors.js';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { fullTimestamp, timeAgo } from '../../lib/formatTime.js';
import { useConfirm } from './ConfirmProvider.jsx';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { TextDirectionField } from './TextDirectionField.jsx';

/**
 * The document's own tab: what it is called, which way it reads, a copy of it,
 * and the end of it. These are here rather than scattered across the editor
 * because they are all about the document as a thing, not about its text or its
 * annotations. Delete in particular used to sit under plaid-ud's tokens, which
 * put an irreversible action at the bottom of a screen people scroll daily.
 *
 * `metadata` is an app's own card for what its projects record about a
 * document, drawn under Details where it has one.
 */
export const DocumentDetailsPage = ({ metadata: Metadata = null }) => {
  const { projectId, documentId, doc, project } = useDocumentEditor();
  const { user, getClient } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const routes = appRoutes();

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
  // A typed name that has not been saved: leaving this screen asks first,
  // whether by the tab strip, a link, Back or a reload.
  useUnsavedDraft(dirty ? 'The name you have typed' : null);
  // The two ways this screen leaves itself. A router push is none of the ways
  // out the hook watches, so it asks here.
  const guardLeaving = useUnsavedGuard();

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
      // The copy is made either way; what is asked about is LEAVING this
      // screen for it, because the name typed above goes with the screen. The
      // question stands immediately before the navigation, not at the top of
      // the handler, so a No cancels nothing the reader asked for.
      if (!(await guardLeaving())) return;
      navigate(routes.document(projectId, created.id));
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
      // Nothing to ask: the document the name was typed for is gone. The extra
      // history entry still comes out before the route changes.
      await dropUnsavedDrafts();
      navigate(routes.documents(projectId));
    } catch (err) {
      notifyError(humanizeError(err), 'Failed to delete document');
      console.error('Error deleting document:', err);
    }
  };

  const modified = doc.raw?.timeModified;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
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

          <TextDirectionField doc={doc} disabled={readOnly} />

          {modified && (
            <p className="text-xs text-muted-foreground" title={fullTimestamp(modified)}>
              Last changed {timeAgo(modified)}.
            </p>
          )}
        </CardContent>
      </Card>

      {Metadata && <Metadata doc={doc} project={project} readOnly={readOnly} />}

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
