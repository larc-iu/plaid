import { useEffect, useRef, useState } from 'react';
import { Info, Pencil, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useBaselineOperations } from './useBaselineOperations.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

export function DocumentBaseline() {
  const { readOnly } = useDocumentCtx();
  const ops = useBaselineOperations();

  // Local state for text input to prevent cursor jumping
  const [localText, setLocalText] = useState('');
  const textareaRef = useRef(null);

  // Auto-grow the textarea with its content (replaces Mantine Textarea autosize),
  // capped so it doesn't run off-screen on huge documents.
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  };

  // Sync local text buffer with the hook's editedText when editing starts
  useEffect(() => {
    if (ops.isEditing) {
      setLocalText(ops.editedText);
      requestAnimationFrame(autoGrow);
    }
  }, [ops.isEditing, ops.editedText]);

  const handleTextChange = (e) => {
    const newText = e.target.value;
    setLocalText(newText);
    ops.updateEditedText(newText);
    autoGrow();
  };

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Baseline Text</h2>
              <p className="text-sm text-muted-foreground">
                Edit the primary text content for this document
              </p>
            </div>
            {!ops.isEditing && !readOnly && (
              <Button variant="outline" size="sm" onClick={ops.handleEdit}>
                <Pencil className="h-4 w-4" /> Edit Text
              </Button>
            )}
          </div>

          <div className="border-t" />

          {ops.isEditing ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="baseline-text">Document Text</Label>
                <Textarea
                  ref={textareaRef}
                  id="baseline-text"
                  value={localText}
                  onChange={handleTextChange}
                  placeholder="Enter the document text..."
                  rows={10}
                  className="resize-none overflow-auto"
                  required
                />
              </div>

              <div className="rounded-md border border-border bg-muted p-3">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-sm">
                    <strong>Note:</strong> Existing tokenization and annotations are kept and
                    adjusted to match your edits. Words inside text you delete are removed
                    along with their annotations.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={ops.handleCancel}
                  disabled={ops.saving}
                >
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button onClick={ops.handleSave} disabled={ops.saving}>
                  <Save className="h-4 w-4" /> {ops.saving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="rounded-md bg-muted p-4">
                  <p className="whitespace-pre-wrap text-sm">
                    {ops.body || ''}
                  </p>
                </div>
              </div>

              {!ops.primaryTextLayer && (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p className="text-sm text-destructive">
                      No primary text layer found for this project. Text editing is not available.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
