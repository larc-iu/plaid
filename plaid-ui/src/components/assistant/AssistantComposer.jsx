import { useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { cn } from '../../lib/utils.js';
import { ACCEPT } from './attachments.js';
import { AttachmentChip } from './AttachmentChip.jsx';
import { AssistantPicker } from './ConversationList.jsx';
import { MentionList } from './MentionList.jsx';
import { NEARLY_FULL, fullness } from './usage.js';
import { useMentions } from './useMentions.js';

// The foot of the chat: what has to be read before the next message is typed,
// the box it is typed into, and the `@` list over it.
//
// The keys are arbitrated HERE, in the composer's own onKeyDown, before the
// Enter that sends: with the `@` list open Enter takes the highlighted row and
// Escape closes the list, and neither sends. That is the one real risk in the
// gesture, and both apps' specs assert it directly.
export const AssistantComposer = ({
  client,
  projectId,
  // Who answers and whether the reader still has a choice about it, as
  // useAssistantChoice reports it.
  choice,
  // The message being typed. It belongs to the chat: sending clears it, and
  // Ask writes a reference into it from outside.
  text,
  setText,
  // The textarea itself, so the chat can put the caret back when a turn lands.
  inputRef,
  canSend,
  // A plan is waiting to be decided, which the placeholder says.
  pendingPlan = false,
  // How full the thread is, from the newest reply that reported it.
  usage = null,
  // What the user pointed at in the editor, as {ref, label}.
  focus = null,
  onClearFocus,
  // What the screen behind the chat offers to `@` (see subject.js).
  mentionOffer = null,
  // The files waiting to go with this message, and the three ways one arrives:
  // the paperclip, a drop anywhere on this box, and a paste. The chat owns
  // them, the way it owns the message; this owns the gestures.
  attachments = [],
  onAttach = null,
  onRemoveAttachment = null,
  attaching = false,
  onSend,
  // A narrow column: tighter padding.
  compact = false,
}) => {
  const { service } = choice;
  const mentions = useMentions({
    client,
    projectId,
    enabled: canSend,
    text,
    setText,
    inputRef,
    offer: mentionOffer,
  });

  const onKeyDown = (e) => {
    if (mentions.handleKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const full = fullness(usage);
  const fileInput = useRef(null);
  const [over, setOver] = useState(false);
  const canAttach = !!onAttach && canSend;

  // A drop anywhere on the composer, not only on a target drawn for it: the
  // box IS the target, and a reader dragging a file at a chat box aims at the
  // box. `dragover` has to be prevented or the browser opens the file instead.
  const onDrop = (e) => {
    if (!canAttach) return;
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer?.files?.length) onAttach(e.dataTransfer.files);
  };

  return (
    <div
      className={cn('border-t', compact ? 'px-3 py-2' : 'px-4 py-3')}
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        // Only the drag actually leaving the composer, not one crossing from
        // the box to the button inside it.
        if (!e.currentTarget.contains(e.relatedTarget)) setOver(false);
      }}
      onDrop={onDrop}
    >
      {/* The conversation's own assistant is gone. Rather than answer in a
          different voice without saying so, name the replacement, and let
          the user choose it where there is more than one. */}
      {choice.wentOffline && service && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            The assistant this conversation started with is offline. Replies now come from{' '}
            <span className="font-medium text-foreground">{service.serviceName}</span>.
          </span>
          {choice.canChoose && (
            <AssistantPicker
              assistants={choice.assistants}
              stranded={choice.stranded}
              value={service.serviceId}
              onChange={choice.choose}
              disabled={!canSend}
            />
          )}
        </div>
      )}
      {/* Nothing manages the window for the reader, so a thread that runs
          long eventually fails a turn outright. Said here, where the next
          message is about to be typed, and with the remedy named: the new
          conversation button is a few pixels away in the header. */}
      {(full ?? 0) >= NEARLY_FULL && (
        <p className="mx-auto mb-2 max-w-3xl text-xs text-amber-600 dark:text-amber-500">
          This conversation is {Math.round(full * 100)}% full. Start a new one before it stops
          fitting.
        </p>
      )}
      {focus && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-1">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-1 pl-2.5 pr-1 text-xs">
            <span className="font-medium">{focus.label}</span>
            <span className="text-muted-foreground">{focus.ref}</span>
            <button
              type="button"
              onClick={() => onClearFocus?.()}
              title="Remove"
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}
      {/* `relative`, because the `@` list hangs off the top of this box
          rather than off the caret: measuring a character position inside a
          textarea needs a mirror element and breaks on wrap and on resize,
          and the composer is never far from the caret anyway. */}
      {attachments.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-1.5">
          {attachments.map((f) => (
            <AttachmentChip key={f.id} file={f} onRemove={onRemoveAttachment} />
          ))}
        </div>
      )}
      <div
        className={cn(
          'relative mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring',
          over && 'border-primary ring-1 ring-primary',
        )}
      >
        {mentions.open && (
          <MentionList
            groups={mentions.groups}
            activeId={mentions.activeId}
            onPick={mentions.pick}
            onHover={mentions.setActiveId}
            loading={mentions.loading}
          />
        )}
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            mentions.noteCaret(e.target.selectionStart);
          }}
          onKeyUp={mentions.trackCaret}
          onSelect={mentions.trackCaret}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // A file pasted from the desktop. Pasted TEXT is left alone: it is
            // already in the box, which is where someone pasting it wants it.
            if (canAttach && e.clipboardData?.files?.length) {
              e.preventDefault();
              onAttach(e.clipboardData.files);
            }
          }}
          placeholder={
            !service
              ? 'No assistant online'
              : pendingPlan
                ? 'Approve or discard the plan above, or keep talking'
                : 'Message the assistant… (Enter to send, Shift+Enter for a new line)'
          }
          disabled={!canSend}
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
        />
        {onAttach && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT.join(',')}
              className="hidden"
              onChange={(e) => {
                onAttach(e.target.files);
                // So the same file picked twice in a row is picked twice.
                e.target.value = '';
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => fileInput.current?.click()}
              disabled={!canAttach}
              title="Attach"
              aria-label="Attach a file"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          onClick={() => onSend()}
          disabled={!canSend || !text.trim() || attaching}
          title="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
