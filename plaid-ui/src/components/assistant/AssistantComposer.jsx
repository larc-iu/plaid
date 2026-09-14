import { Send, X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { cn } from '../../lib/utils.js';
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

  return (
    <div className={cn('border-t', compact ? 'px-3 py-2' : 'px-4 py-3')}>
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
      <div className="relative mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
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
        <Button
          type="button"
          size="sm"
          onClick={() => onSend()}
          disabled={!canSend || !text.trim()}
          title="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
