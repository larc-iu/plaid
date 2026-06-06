import { useState, useEffect, useRef } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cpSlice } from '@larc-iu/plaid-client';
import { cn } from '@/lib/utils';
import { notifySuccess } from '@/utils/feedback';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useAlignmentEditor } from './useAlignmentEditor.js';

// Matches Mantine useHotkeys default: ignore key events originating from form fields.
const TAGS_TO_IGNORE = ['INPUT', 'TEXTAREA', 'SELECT'];

export const TimeAlignmentPopover = ({
  opened,
  onClose,
  selection,
  onAlignmentCreated,
  selectionBox,
  readOnly = false
}) => {
  const { doc } = useDocumentCtx();
  const [mode, setMode] = useState('new'); // 'new', 'edit', or 'align'
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Use the alignment editor hook
  const {
    isProcessing,
    createAlignment,
    editAlignment,
    alignBaseline,
    deleteAlignment,
    getAvailableText,
    getExistingAlignment,
    canAlign
  } = useAlignmentEditor(selection, onAlignmentCreated);

  // Find existing alignment token that matches current selection
  const existingAlignment = getExistingAlignment();

  // Set initial text and mode based on whether alignment exists
  useEffect(() => {
    if (opened) {
      if (existingAlignment) {
        setMode('edit');
        // Extract text using token positions from primary text layer
        const tokenText = cpSlice(doc.body || '', existingAlignment.begin, existingAlignment.end) || '';
        setText(tokenText);
      } else {
        // Default to 'new' mode, let user choose
        setMode('new');
        setText('');
      }
    }
  }, [opened, existingAlignment]);

  // Handle mode changes
  const handleModeChange = (newMode) => {
    setMode(newMode);
    if (newMode === 'align') {
      const availableText = getAvailableText();
      setText(availableText);
    } else {
      setText('');
    }
  };

  // Auto-select text when editing existing alignment or aligning baseline text
  useEffect(() => {
    if (opened && (mode === 'edit' || mode === 'align') && textareaRef.current && text) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.select();
        }
      });
    }
  }, [opened, mode]);

  const handleCancel = () => {
    setText('');
    setMode('new');
    onClose();
  };

  const handleSave = async () => {
    if (!text.trim() || saving || isProcessing) return;

    setSaving(true);
    try {
      let ok;
      if (mode === 'edit' && existingAlignment) {
        // Edit existing alignment
        ok = await editAlignment(text, existingAlignment);
      } else if (mode === 'align') {
        // Align existing baseline text
        ok = await alignBaseline(text);
      } else {
        // Create new alignment
        ok = await createAlignment(text);
      }

      if (!ok) return; // Domain method toasted the error via doc.onError

      notifySuccess(
        mode === 'edit' ? 'Alignment updated successfully' :
          mode === 'align' ? 'Text aligned successfully' :
            'Time-aligned text created successfully',
        'Success'
      );

      // Reset and close immediately
      setText('');
      setMode('new');
      onClose();

    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingAlignment || saving || isProcessing) return;

    setSaving(true);
    try {
      const ok = await deleteAlignment(existingAlignment);

      if (!ok) return; // Domain method toasted the error via doc.onError

      notifySuccess('Alignment deleted successfully', 'Success');

      // Reset and close immediately
      setText('');
      setMode('new');
      onClose();

    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcuts (disabled in read-only mode). Mirrors the old Mantine
  // useHotkeys: bound on document, ignored when the event originates in a form field.
  useEffect(() => {
    if (!opened || readOnly) return;
    const onKeyDown = (e) => {
      if (TAGS_TO_IGNORE.includes(e.target?.tagName)) return;
      if (e.key === 'Escape') {
        handleCancel();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleSave();
      } else if (e.key === 'Delete' && mode === 'edit') {
        handleDelete();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, readOnly, mode, text, saving, isProcessing, existingAlignment]);

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const stop = (e) => e.stopPropagation();

  return (
    <Popover open={opened} onOpenChange={() => { /* controlled; never auto-close */ }}>
      <PopoverAnchor asChild>{selectionBox}</PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="center"
        className="w-[400px]"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onClick={stop}
        onMouseDown={stop}
        onMouseUp={stop}
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium">
              {readOnly ? 'View Time Alignment' : (
                mode === 'edit' ? 'Edit Alignment' :
                  mode === 'align' ? 'Align Baseline Text' :
                    'Create Time Alignment'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatTime(selection?.start || 0)} - {formatTime(selection?.end || 0)}
              {readOnly && ' (read-only mode)'}
              {!readOnly && mode === 'edit' && ' (editing existing)'}
              {!readOnly && mode === 'align' && ' (aligning baseline text)'}
            </p>
          </div>

          {!readOnly && mode !== 'edit' && (
            <div className="inline-flex rounded-md border p-0.5 text-sm">
              {[
                { label: 'Create New', value: 'new' },
                { label: 'Align Existing', value: 'align' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleModeChange(opt.value)}
                  className={cn(
                    'flex-1 rounded px-3 py-1 transition-colors',
                    mode === opt.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {readOnly ? (
            // Read-only content display
            <div>
              <p className="mb-1 text-sm font-medium">Content</p>
              <p className="flex min-h-[60px] items-center rounded border bg-muted px-3 py-2 text-sm">
                {existingAlignment ?
                  cpSlice(doc.body || '', existingAlignment.begin, existingAlignment.end) || 'No content' :
                  'No alignment data for this time range'
                }
              </p>
            </div>
          ) : mode === 'align' && !canAlign() ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
              <p className="text-sm">
                No unaligned baseline text is available in this time range.
                All text between neighboring alignments has already been aligned.
              </p>
            </div>
          ) : (mode === 'new' || mode === 'edit' || mode === 'align') && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="alignment-text">
                {mode === 'align' ? 'Baseline Text to Align' : 'Transcription'} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="alignment-text"
                ref={textareaRef}
                placeholder={mode === 'align' ? 'Select portion of text to align...' : 'Enter the text for this time segment...'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                className="max-h-48"
                required
              />
              {mode === 'align' && (
                <p className="text-xs text-muted-foreground">
                  Edit this text to select the portion you want to align with the time selection.
                </p>
              )}
            </div>
          )}

          {readOnly ? (
            // Read-only mode: just a close button
            <div className="flex justify-end">
              <Button variant="ghost" onClick={handleCancel}>Close</Button>
            </div>
          ) : (
            // Edit mode: full set of action buttons
            <div className="flex items-center justify-between">
              <div>
                {mode === 'edit' && (
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={saving || isProcessing}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={handleCancel}
                  disabled={saving || isProcessing}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!text.trim() || (mode === 'align' && !canAlign()) || saving || isProcessing}
                >
                  {saving || isProcessing ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          )}

          <p className="text-xs italic text-muted-foreground">
            {readOnly ? (
              'Read-only mode: Content cannot be modified in this view.'
            ) : (
              <>
                Tip: Press Ctrl+Enter to save, Escape to cancel{mode === 'edit' ? ', Delete to remove' : ''}
                {mode === 'align' && '. Modify the text above to select which portion to align.'}
              </>
            )}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
