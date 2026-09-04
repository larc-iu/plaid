import { useState, useEffect, useRef } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { notifySuccess } from '@/utils/feedback';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useAlignmentEditor } from './useAlignmentEditor.js';
import { formatTime } from './formatTime.js';
import { getStickySpeaker, setStickySpeaker } from './stickySpeaker.js';

// The popover for a stretch dragged out on the timeline: make a segment from
// new text, or from text already in the baseline. That is all it does now. An
// existing segment is edited in its transcript row, which a click on the
// timeline focuses, so there is no edit mode here and nothing is ever
// pre-selected: the caret sits at the end of whatever the box holds.
export const TimeAlignmentPopover = ({
  opened,
  onClose,
  selection,
  onAlignmentCreated,
  selectionBox,
}) => {
  const { doc } = useDocumentCtx();
  const [mode, setMode] = useState('new'); // 'new' or 'align'
  const [text, setText] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  const { isProcessing, createAlignment, alignBaseline, getAvailableText, canAlign } =
    useAlignmentEditor(selection, onAlignmentCreated);

  // A fresh popover every time it opens.
  useEffect(() => {
    if (opened) {
      setMode('new');
      setText('');
      setSpeaker(getStickySpeaker());
    }
  }, [opened]);

  // Focus the box with the caret at the end, never with its contents selected:
  // in the existing-text mode the job is to trim, and a stray key must not
  // replace the whole thing.
  useEffect(() => {
    if (!opened) return;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [opened, mode]);

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setText(newMode === 'align' ? getAvailableText() : '');
  };

  const handleCancel = () => {
    setText('');
    setMode('new');
    onClose();
  };

  const handleSave = async () => {
    if (!text.trim() || saving || isProcessing) return;
    setSaving(true);
    try {
      const sp = speaker.trim();
      const ok = mode === 'align' ? await alignBaseline(text, sp) : await createAlignment(text, sp);
      if (!ok) return; // the document toasted the reason
      setStickySpeaker(sp);
      notifySuccess(mode === 'align' ? 'Text aligned' : 'Segment created', 'Success');
      setText('');
      setMode('new');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // Keys are handled on the popover itself, so they work inside the boxes.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const stop = (e) => e.stopPropagation();

  return (
    <Popover
      open={opened}
      onOpenChange={() => {
        /* controlled: closed by Cancel, Save, Esc, or an outside click on an empty box */
      }}
    >
      <PopoverAnchor asChild>{selectionBox}</PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="center"
        className="w-[400px]"
        onInteractOutside={(e) => {
          // A click elsewhere closes an untouched popover and leaves one with
          // typing in it alone, so a stray click never eats work.
          if (text.trim()) e.preventDefault();
          else onClose();
        }}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onClick={stop}
        onMouseDown={stop}
        onMouseUp={stop}
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium">
              {mode === 'align' ? 'Align existing text' : 'New segment'}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatTime(selection?.start || 0)} - {formatTime(selection?.end || 0)}
            </p>
          </div>

          <div className="inline-flex rounded-md border p-0.5 text-sm">
            {[
              { label: 'New text', value: 'new' },
              { label: 'Existing text', value: 'align' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleModeChange(opt.value)}
                className={cn(
                  'flex-1 rounded px-3 py-1 transition-colors',
                  mode === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {mode === 'align' && !canAlign() ? (
            <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
              <p className="text-sm">
                No unaligned text is available for this time range. Everything between the
                neighboring segments already belongs to a segment.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="alignment-text">
                  {mode === 'align' ? 'Text to align' : 'Transcription'}{' '}
                  <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="alignment-text"
                  compose
                  ref={textareaRef}
                  placeholder={
                    mode === 'align'
                      ? 'Keep the part of the text this segment covers'
                      : 'Text of this segment'
                  }
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  className="max-h-48"
                  required
                />
                {mode === 'align' && (
                  <p className="text-xs text-muted-foreground">
                    Trim this to the part of the text the selected time covers.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="alignment-speaker">Speaker</Label>
                <Input
                  id="alignment-speaker"
                  compose
                  list="alignment-speaker-options"
                  placeholder="e.g. Speaker 1 (optional)"
                  value={speaker}
                  onChange={(e) => setSpeaker(e.target.value)}
                  autoComplete="off"
                />
                <datalist id="alignment-speaker-options">
                  {doc.knownSpeakers.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel} disabled={saving || isProcessing}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!text.trim() || (mode === 'align' && !canAlign()) || saving || isProcessing}
            >
              {saving || isProcessing ? 'Saving…' : 'Save'}
            </Button>
          </div>

          <p className="text-xs italic text-muted-foreground">Ctrl/Cmd+Enter saves, Esc cancels.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
