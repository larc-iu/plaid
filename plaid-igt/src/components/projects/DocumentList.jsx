import { useState } from 'react';
import { Plus } from 'lucide-react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

export const DocumentList = ({ documents, projectId, client, onDocumentCreated }) => {
  const [open, setOpen] = useState(false);
  const [documentName, setDocumentName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleDocumentClick = (document) => {
    window.location.href = `#/projects/${projectId}/documents/${document.id}`;
  };

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
      const primaryTextLayer = projectData?.textLayers?.find((layer) => layer.config?.plaid?.primary);
      if (primaryTextLayer) {
        await client.texts.create(primaryTextLayer.id, newDocument.id, '', {});
      }
      notifySuccess(`Document "${documentName}" created successfully`, 'Success');
      setDocumentName('');
      setOpen(false);
      if (onDocumentCreated) onDocumentCreated({ ...newDocument, name: documentName.trim() });
    } catch (error) {
      console.error('Failed to create document:', error);
      notifyError(`Failed to create document: ${error.message}`, 'Error');
    } finally {
      setIsCreating(false);
    }
  };

  const sorted = [...documents].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="tw mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Documents</h2>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Create Document
        </Button>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-md border py-12 text-center text-muted-foreground">
          <p className="text-base">No documents found</p>
          <p className="mt-1 text-sm">This project doesn&apos;t have any documents yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Document Name</th>
                <th className="px-4 py-2 font-medium">ID</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => handleDocumentClick(d)}
                  className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                >
                  <td className="px-4 py-2">{d.name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{d.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Document</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="doc-name">Document Name</Label>
            <Input
              id="doc-name"
              placeholder="Enter document name"
              value={documentName}
              onChange={(e) => setDocumentName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && documentName.trim() && !isCreating) handleCreateDocument();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={handleCreateDocument} disabled={!documentName.trim() || isCreating}>
              {isCreating ? 'Creating…' : 'Create Document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
