import { useState, useEffect, useRef } from 'react';
import { cpLength } from '@larc-iu/plaid-client';
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
import { snapToWords } from './selectWords.js';

// The popover for a stretch dragged out on the timeline: make a segment from
// new text, or from text already in the baseline. That is all it does. An
// existing segment is edited in its transcript row, which a click on the
// timeline focuses, so there is no edit mode here.
//
// "Existing text" shows the baseline text still free between the neighbouring
// segments in a read-only box, and the segment is whatever you SELECT in it,
// snapped to whole words. The box used to be editable and expected you to
// trim it down to the segment, which nobody guessed: the first thing everyone
// did was highlight the words.
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
  // Existing-text mode: the free stretch of the baseline, and the part of it
  // picked so far (UTF-16 offsets into `available`, as the textarea reports).
  const [available, setAvailable] = useState('');
  const [picked, setPicked] = useState(null);
  const [speaker, setSpeaker] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  const {
    isProcessing,
    createAlignment,
    alignBaseline,
    getAvailableText,
    getAvailableTextBoundaries,
    canAlign,
  } = useAlignmentEditor(selection, onAlignmentCreated);

  // A fresh popover every time it opens.
  useEffect(() => {
    if (opened) {
      setMode('new');
      setText('');
      setAvailable('');
      setPicked(null);
      setSpeaker(getStickySpeaker());
    }
  }, [opened]);

  // Focus the box. New text: caret at the end of whatever is there, never
  // with the contents selected, so a stray key cannot replace them. Existing
  // text: caret at the start, where the next segment's words usually begin,
  // so Shift+Right selects them from the keyboard.
  useEffect(() => {
    if (!opened) return;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const n = mode === 'align' ? 0 : el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [opened, mode]);

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setText('');
    setAvailable(newMode === 'align' ? getAvailableText() : '');
    setPicked(null);
  };

  const handleCancel = () => {
    setText('');
    setPicked(null);
    setMode('new');
    onClose();
  };

  // What the box has selected, snapped to whole words. Read on every
  // selection change, mouse-up and key-up, since the `select` event alone
  // does not report a selection collapsing back to a caret everywhere.
  const readSelection = (e) => {
    const el = e.currentTarget;
    setPicked(snapToWords(available, el.selectionStart, el.selectionEnd));
  };

  const pickedText = picked ? available.slice(picked.start, picked.end) : '';
  const ready = mode === 'align' ? !!picked : !!text.trim();

  const handleSave = async () => {
    if (!ready || saving || isProcessing) return;
    setSaving(true);
    try {
      const sp = speaker.trim();
      let ok;
      if (mode === 'align') {
        // The free stretch may have moved under an open popover (a save in
        // another row); the selection only means something against the
        // stretch it was made in.
        if (getAvailableText() !== available) {
          setAvailable(getAvailableText());
          setPicked(null);
          return;
        }
        const { leftBoundary } = getAvailableTextBoundaries();
        const begin = leftBoundary + cpLength(available.slice(0, picked.start));
        const end = leftBoundary + cpLength(available.slice(0, picked.end));
        ok = await alignBaseline(begin, end, sp);
      } else {
        ok = await createAlignment(text, sp);
      }
      if (!ok) return; // the document toasted the reason
      setStickySpeaker(sp);
      notifySuccess(mode === 'align' ? 'Text aligned' : 'Segment created', 'Success');
      setText('');
      setPicked(null);
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
        /* controlled: closed by Cancel, Save, Esc, or an outside click on an untouched popover */
      }}
    >
      <PopoverAnchor asChild>{selectionBox}</PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="center"
        className="w-[400px]"
        onInteractOutside={(e) => {
          // A click elsewhere closes an untouched popover and leaves one with
          // typing or a selection in it alone, so a stray click never eats work.
          if (ready) e.preventDefault();
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
                  {mode === 'align' ? 'Baseline text' : 'Transcription'}{' '}
                  {mode === 'new' && <span className="text-destructive">*</span>}
                </Label>
                {mode === 'align' ? (
                  // Not `readOnly`: Chromium then ignores the caret keys, and
                  // Shift+Arrow could not select. Every edit is refused at
                  // `beforeinput` instead (typing, paste, drop, IME), which
                  // keeps the caret and the selection keys alive.
                  <Textarea
                    id="alignment-text"
                    ref={textareaRef}
                    aria-readonly="true"
                    value={available}
                    onChange={() => {}}
                    onBeforeInput={(e) => e.preventDefault()}
                    rows={5}
                    spellCheck={false}
                    className="max-h-48"
                    onSelect={readSelection}
                    onMouseUp={readSelection}
                    onKeyUp={readSelection}
                  />
                ) : (
                  <Textarea
                    id="alignment-text"
                    compose
                    ref={textareaRef}
                    placeholder="Text of this segment"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={3}
                    className="max-h-48"
                    required
                  />
                )}
                {mode === 'align' &&
                  (picked ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground" data-picked-text>
                      Segment: “{pickedText}”
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Select the words this segment covers.
                    </p>
                  ))}
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
              disabled={!ready || (mode === 'align' && !canAlign()) || saving || isProcessing}
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
