import { Info, Pencil, Save, X, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMetadataOperations } from './useMetadataOperations.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

export function DocumentMetadata() {
  const { readOnly } = useDocumentCtx();
  const ops = useMetadataOperations();

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Document Information</h2>
            {!ops.isEditing && !readOnly && (
              <Button variant="outline" size="sm" onClick={ops.handleEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
          </div>

          <div className="border-t" />

          {ops.isEditing ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>
                  Document Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={ops.editedName}
                  onChange={(e) => ops.updateEditedName(e.target.value)}
                  placeholder="Enter document name"
                />
              </div>

              {ops.metadataFields.map((field) => (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <Label>{field.name}</Label>
                  <Input
                    value={ops.editedMetadata[field.name] || ''}
                    onChange={(e) => ops.updateEditedMetadata(field.name, e.target.value)}
                    placeholder={`Enter ${field.name}`}
                  />
                </div>
              ))}

              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  className="opacity-70"
                  onClick={ops.handleDeleteClick}
                  disabled={ops.saving || ops.deleting}
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={ops.handleCancel}
                    disabled={ops.saving || ops.deleting}
                  >
                    <X className="h-4 w-4" /> Cancel
                  </Button>
                  <Button
                    onClick={ops.handleSave}
                    disabled={ops.saving || !ops.editedName.trim() || ops.deleting}
                  >
                    <Save className="h-4 w-4" /> {ops.saving ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 text-sm font-bold">Name</p>
                <p>{ops.document.name}</p>
              </div>

              <div>
                <p className="mb-1 text-sm font-bold">Document ID</p>
                <p className="font-mono text-sm">{ops.document.id}</p>
              </div>

              {/* Show configured metadata fields */}
              {ops.metadataFields.map((field) => {
                const value = ops.document.metadata[field.name]
                return (
                    <div key={field.name}>
                      <p className="mb-1 text-sm font-bold">{field.name}</p>
                      <p className={value ? '' : 'text-muted-foreground'}>{value || 'Not set'}</p>
                    </div>
                )
              })}

              {ops.metadataFields.length === 0 && (!ops.document.metadata || Object.keys(ops.document.metadata).length === 0) && (
                <div className="rounded-md border border-blue-500/50 bg-blue-500/5 p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                    <p className="text-sm text-muted-foreground">
                      No metadata fields configured for this project. You can add metadata fields
                      in the project settings.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog open={ops.deleteModalOpen} onOpenChange={(open) => { if (!open) ops.handleCloseDeleteModal(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Document</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">This action is irreversible</p>
                  <p className="mt-1 text-muted-foreground">
                    You are about to permanently delete the document <strong>"{ops.document.name}"</strong> and
                    all of its associated data including annotations and text content.
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={ops.handleCloseDeleteModal}
                disabled={ops.deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={ops.handleDelete}
                disabled={ops.deleting}
              >
                <Trash2 className="h-4 w-4" /> {ops.deleting ? 'Deleting...' : 'Delete Document'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
