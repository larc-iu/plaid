import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AudioLines, ChevronRight, PenLine, Plus } from 'lucide-react';
import { DocumentTable } from '@ui/components/shared/DocumentTable.jsx';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { findBaselineTextLayer } from '@/domain/igtConfig';

export const DocumentList = ({
  documents,
  project,
  projectId,
  client,
  canManage,
  canWrite = true,
  onDocumentCreated,
}) => {
  const [open, setOpen] = useState(false);
  // A maintainer picks how to add a document first, the way New Project does:
  // an import is a way of making one, not a separate button in the header. A
  // writer who cannot import goes straight to the name.
  const [choosing, setChoosing] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreateDocument = async () => {
    if (!documentName.trim()) {
      notifyError('Document name is required', 'Error');
      return;
    }
    setIsCreating(true);
    try {
      if (!client) throw new Error('Authentication required');
      const newDocument = await client.documents.create(projectId, documentName.trim());
      const projectData = await client.projects.get(projectId);
      const primaryTextLayer = findBaselineTextLayer(projectData?.textLayers);
      if (primaryTextLayer) {
        await client.texts.create(primaryTextLayer.id, newDocument.id, '', {});
      }
      notifySuccess(`Document "${documentName}" created`, 'Success');
      setDocumentName('');
      setOpen(false);
      if (onDocumentCreated) onDocumentCreated({ ...newDocument, name: documentName.trim() });
      // A new document is empty, so the next thing to do is type its text.
      navigate(`/projects/${projectId}/documents/${newDocument.id}?tab=baseline`);
    } catch (error) {
      console.error('Failed to create document:', error);
      notifyError(humanizeError(error, 'Could not create the document.'), 'Error');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Documents</h2>
        {canWrite && (
          <Button
            onClick={() => {
              setChoosing(canManage);
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> New Document
          </Button>
        )}
      </div>

      <DocumentTable
        documents={documents}
        client={client}
        projectId={projectId}
        wordLayerId={getIgtLayerInfo(project).primaryTokenLayer?.id}
        href={(documentId) => `/projects/${projectId}/documents/${documentId}`}
        defaultSort={{ key: 'updated', dir: 'desc' }}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New document</DialogTitle>
            <DialogDescription>
              {choosing
                ? 'How would you like to add one?'
                : 'Name the document. Its text goes on the Baseline tab.'}
            </DialogDescription>
          </DialogHeader>
          {choosing ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setChoosing(false)}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <PenLine className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">Blank document</span>
                  <span className="block text-xs text-muted-foreground">
                    Name it now and add its text on the Baseline tab.
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              <Link
                to={`/projects/${projectId}/import-elan`}
                className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left hover:bg-muted/50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
                  <AudioLines className="h-4 w-4 text-muted-foreground" />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-medium">Import from ELAN</span>
                  <span className="block text-xs text-muted-foreground">
                    One document per .eaf file, with its tiers, speakers and time alignment.
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="doc-name">Document Name</Label>
                <Input
                  id="doc-name"
                  placeholder="Enter document name"
                  value={documentName}
                  onChange={(e) => setDocumentName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && documentName.trim() && !isCreating)
                      handleCreateDocument();
                  }}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateDocument}
                  disabled={!documentName.trim() || isCreating}
                >
                  {isCreating ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
