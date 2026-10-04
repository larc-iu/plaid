import { useEffect, useRef } from 'react';
import { Info, Pencil, Save, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Textarea } from '@ui/components/ui/textarea';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
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

  // Fit the box to the text the editor opens with, and give it the caret:
  // Edit text is gone once the editor is open, and a blank document opens
  // straight into it. Closed by Save or Cancel, which go with it, the caret
  // goes back to Edit text.
  const editButtonRef = useRef(null);
  const wasEditing = useRef(ops.isEditing);
  useEffect(() => {
    const opened = ops.isEditing && !wasEditing.current;
    const closed = !ops.isEditing && wasEditing.current;
    wasEditing.current = ops.isEditing;
    const lost = () => !document.activeElement || document.activeElement === document.body;
    if (opened) {
      requestAnimationFrame(() => {
        autoGrow();
        textareaRef.current?.focus();
      });
    } else if (closed) {
      requestAnimationFrame(() => {
        if (lost()) editButtonRef.current?.focus();
      });
    }
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
    ops.handleTextChange(e);
    autoGrow();
  };

  return (
    <div className="flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Baseline text</h2>
            </div>
            {!ops.isEditing && !readOnly && (
              <Button ref={editButtonRef} variant="outline" size="sm" onClick={ops.handleEdit}>
                <Pencil className="h-4 w-4" /> Edit text
              </Button>
            )}
          </div>

          <div className="border-t" />

          {ops.isEditing ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="baseline-text">Document text</Label>
                <Textarea
                  ref={textareaRef}
                  id="baseline-text"
                  compose
                  value={ops.editedText}
                  {...ops.editLogHandlers}
                  onChange={handleTextChange}
                  placeholder="Type or paste the text"
                  readOnly={readOnly}
                  spellCheck={false}
                  rows={10}
                  className="resize-none overflow-auto font-text"
                  required
                />
                {ops.changedElsewhere && (
                  <Notice tone="warning" role="alert">
                    Changed elsewhere in the same passage.
                  </Notice>
                )}
              </div>

              {ops.body?.trim() ? (
                <div className="rounded-md border border-border bg-muted p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-sm">
                      Words inside deleted text are removed with their annotations.
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
                <Button onClick={ops.handleSave} disabled={ops.saving || readOnly}>
                  <Save className="h-4 w-4" /> {ops.saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <div className="rounded-md bg-muted p-4">
                  <p dir="auto" className="whitespace-pre-wrap font-text text-sm">
                    {ops.body || ''}
                  </p>
                </div>
              </div>

              {!ops.primaryTextLayer && (
                <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <p className="text-sm text-destructive">{NOT_SET_UP}</p>
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
