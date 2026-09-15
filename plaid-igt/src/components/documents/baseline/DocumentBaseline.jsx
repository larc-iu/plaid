import { useEffect, useRef } from 'react';
import { Info, Pencil, Save, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Textarea } from '@ui/components/ui/textarea';
import { useBaselineOperations } from './useBaselineOperations.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

export function DocumentBaseline() {
  const { doc, readOnly } = useDocumentCtx();
  const ops = useBaselineOperations();

  // The textarea is controlled by the hook's `editedText` alone. It used to
  // carry a second copy here and an effect writing one into the other on every
  // keystroke, which is the shape that produces "Maximum update depth
  // exceeded" and did, five times over, when a whole transcript arrived in one
  // change. `setEditedText` is plain state in a hook this component calls, so
  // there is no round trip for the caret to jump across.
  const textareaRef = useRef(null);

  // Auto-grow the textarea with its content, capped so it doesn't run
  // off-screen on huge documents.
  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  };

  // Fit the box to the text the editor opens with.
  useEffect(() => {
    if (ops.isEditing) requestAnimationFrame(autoGrow);
  }, [ops.isEditing]);

  // A document with no text yet opens straight into the editor: typing the
  // text is the only thing to do here, and a button in front of an empty box
  // is a step nobody needs.
  const emptyOnArrival = !readOnly && !(doc.body || '').trim();
  useEffect(() => {
    if (emptyOnArrival && !ops.isEditing) ops.handleEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTextChange = (e) => {
    ops.updateEditedText(e.target.value);
    autoGrow();
  };

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Baseline Text</h2>
              <p className="text-sm text-muted-foreground">
                The text you are analyzing, written the way you work with it.
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
                  compose
                  value={ops.editedText}
                  onChange={handleTextChange}
                  placeholder="Type or paste the text"
                  spellCheck={false}
                  rows={10}
                  className="resize-none overflow-auto"
                  required
                />
              </div>

              {ops.body?.trim() ? (
                <div className="rounded-md border border-border bg-muted p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-sm">
                      Existing sentences, words, and annotations are kept and adjusted to match your
                      edits. Words inside text you delete are removed along with their annotations.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Each line becomes a sentence. Sentence breaks can be moved later on the Tokenize
                  tab.
                </p>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={ops.handleCancel} disabled={ops.saving}>
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
                  <p dir="auto" className="whitespace-pre-wrap text-sm">
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
}
