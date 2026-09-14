import React, { useState, useCallback } from 'react';
import { Check, Undo2, PenLine, Tags } from 'lucide-react';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { Button } from '@ui/components/ui/button';
import { SentenceComments } from './SentenceComments.jsx';
import { SentenceMetadataDialog } from './SentenceMetadataDialog.jsx';
import { useEditorSession } from './editorSession.js';

// Everything the sentence itself offers, BELOW the grid and left-aligned with
// the first token so it reads as belonging to this sentence. Two kinds, told
// apart by weight rather than by position: Accept and Discard are outlined and
// only appear when they have something to do, while the four standing actions
// are one dimmed icon-and-label treatment apiece (`sentence-action`) because
// none of them is the thing you came to the sentence to do. The metadata
// disclosure is one of the four: it used to be a bold SENTENCE heading on its
// own line, which made housekeeping the loudest thing under the grid.
//
// `onEditText` is bound to this sentence by the row, which also passes it to
// the tree. The rest of what this needs is the same for every sentence and
// comes from the session.
export const SentenceActions = React.memo(
  ({ sentenceData, sentenceNumber, commentAnchorLabel, hasInferred, hasMachine, onEditText }) => {
    const {
      isReadOnly,
      onConfirmTokens,
      onDiscardTokens,
      onSentenceMetadata,
      onAskAssistant,
      comments,
      canComment,
      canDeleteAnyComment,
      sentenceFields,
    } = useEditorSession();

    const tokenData = sentenceData.tokens;

    const handleConfirmSentence = useCallback(() => {
      onConfirmTokens?.(tokenData.map((d) => d.token.id));
    }, [onConfirmTokens, tokenData]);

    const handleDiscardSentence = useCallback(() => {
      onDiscardTokens?.(tokenData.map((d) => d.token.id));
    }, [onDiscardTokens, tokenData]);

    // The sentence's own notes: sent_id, whatever the project declares, and
    // whatever is already stored that it no longer does. They live on the
    // SENTENCE TOKEN, which is where CoNLL-U's `# k = v` lines have always been
    // read from and written back to. They open in a dialog of their own, one
    // sentence at a time.
    const sentenceToken = sentenceData.sentenceToken;
    const sentenceMeta = sentenceToken?.metadata;
    const [metaOpen, setMetaOpen] = useState(false);
    const handleSentenceMetadata = useCallback(
      (key, value) => onSentenceMetadata?.(sentenceToken?.id, key, value),
      [onSentenceMetadata, sentenceToken],
    );

    return (
      <>
        {(onEditText ||
          comments ||
          onAskAssistant ||
          sentenceToken ||
          (!isReadOnly && (hasInferred || hasMachine))) && (
          <div className="sentence-confirm">
            {!isReadOnly && onConfirmTokens && hasInferred && (
              <Button
                className="accept-predictions-btn h-6 gap-1 px-2 text-xs"
                variant="outline"
                onClick={handleConfirmSentence}
                title="Accept every proposal in this sentence as it stands. Ctrl/Cmd+Enter does one word."
              >
                <Check width={12} height={12} />
                Accept predictions
              </Button>
            )}
            {!isReadOnly && onDiscardTokens && hasMachine && (
              <Button
                className="discard-predictions-btn h-6 gap-1 px-2 text-xs"
                variant="outline"
                onClick={handleDiscardSentence}
                title="Delete every machine annotation in this sentence that nobody has confirmed. Ctrl/Cmd+Backspace does one word."
              >
                <Undo2 width={12} height={12} />
                Discard predictions
              </Button>
            )}
            {sentenceToken && (
              <Button
                className="sentence-meta__toggle sentence-action h-6 gap-1 px-2 text-xs"
                variant="ghost"
                onClick={() => setMetaOpen(true)}
                title="Edit this sentence's CoNLL-U comment lines"
              >
                <Tags width={12} height={12} />
                Edit metadata
              </Button>
            )}
            {onEditText && (
              <Button
                className="edit-text-btn sentence-action h-6 gap-1 px-2 text-xs"
                variant="ghost"
                onClick={onEditText}
                title="Open this sentence in the Text Editor. Alt+click a word does the same."
              >
                <PenLine width={12} height={12} />
                Edit text
              </Button>
            )}
            {onAskAssistant && (
              <Button
                className="sentence-action h-6 gap-1 px-2 text-xs"
                variant="ghost"
                onClick={() => onAskAssistant({ ref: `s${sentenceNumber}`, label: 'Sentence' })}
                title="Ask the assistant about this sentence"
              >
                <AssistantMark className="h-3.5 w-3.5" />
                Ask
              </Button>
            )}
            {comments && sentenceToken?.id && (
              <SentenceComments
                store={comments}
                sentenceId={sentenceToken.id}
                anchorLabel={commentAnchorLabel}
                canWrite={canComment}
                canDeleteAny={canDeleteAnyComment}
              />
            )}
          </div>
        )}

        {sentenceToken && (
          <SentenceMetadataDialog
            open={metaOpen}
            onOpenChange={setMetaOpen}
            label={`sentence ${sentenceNumber}`}
            fields={sentenceFields}
            values={sentenceMeta}
            readOnly={isReadOnly || !onSentenceMetadata}
            onCommit={handleSentenceMetadata}
          />
        )}
      </>
    );
  },
);
