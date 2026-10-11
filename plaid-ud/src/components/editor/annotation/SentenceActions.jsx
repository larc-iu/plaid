import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Check, Undo2, PenLine, Tags } from 'lucide-react';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { cn } from '@ui/lib/utils.js';
import { SENTENCE_ACTION, SENTENCE_REVIEW } from '@ui/components/shared/sentenceActions.js';
import { SentenceComments } from '@ui/components/shared/SentenceComments';
import { SentenceMetadataDialog } from './SentenceMetadataDialog.jsx';
import { useEditorSession } from './editorSession.js';

// Everything the sentence itself offers, BELOW the grid and left-aligned with
// the first token so it reads as belonging to this sentence. Two kinds, told
// apart by weight rather than by position: Accept and Discard are outlined and
// only appear when they have something to do (plaid-ui's SENTENCE_REVIEW),
// while the four standing actions are the plain icon-and-label treatment every
// app's sentence actions wear (SENTENCE_ACTION), because none of them is the
// thing you came to the sentence to do. The metadata
// disclosure is one of the four: it used to be a bold SENTENCE heading on its
// own line, which made housekeeping the loudest thing under the grid.
//
// `editTextTo` is the address of this sentence in the Text Editor, from the
// row, so Edit text is a real link that opens in a new tab too. The rest of what this needs is the same for every sentence and
// comes from the session.
export const SentenceActions = React.memo(
  ({ sentenceData, sentenceNumber, commentAnchorLabel, hasInferred, hasMachine, editTextTo }) => {
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
        {(editTextTo ||
          comments ||
          onAskAssistant ||
          sentenceToken ||
          (!isReadOnly && (hasInferred || hasMachine))) && (
          <div className="sentence-confirm">
            {!isReadOnly && onConfirmTokens && hasInferred && (
              <button
                type="button"
                className={cn(
                  SENTENCE_REVIEW,
                  'accept-predictions-btn plaid-review plaid-review--accept',
                )}
                onClick={handleConfirmSentence}
                title="Accept every proposal in this sentence as it stands. Ctrl/Cmd+Enter to do one word."
              >
                <Check width={12} height={12} />
                Accept predictions
              </button>
            )}
            {!isReadOnly && onDiscardTokens && hasMachine && (
              <button
                type="button"
                className={cn(
                  SENTENCE_REVIEW,
                  'discard-predictions-btn plaid-review plaid-review--discard',
                )}
                onClick={handleDiscardSentence}
                title="Delete every machine annotation in this sentence that nobody has confirmed. Ctrl/Cmd+Backspace to do one word."
              >
                <Undo2 width={12} height={12} />
                Discard predictions
              </button>
            )}
            {sentenceToken && (
              <button
                type="button"
                className={cn(SENTENCE_ACTION, 'sentence-meta__toggle sentence-action')}
                onClick={() => setMetaOpen(true)}
                title="Edit this sentence's CoNLL-U comment lines"
              >
                <Tags width={12} height={12} />
                Edit metadata
              </button>
            )}
            {editTextTo && (
              <Link
                to={editTextTo}
                className={cn(SENTENCE_ACTION, 'edit-text-btn sentence-action')}
                title="Open this sentence in the Text Editor. Alt+click a word to do the same."
              >
                <PenLine width={12} height={12} />
                Edit text
              </Link>
            )}
            {onAskAssistant && (
              <button
                type="button"
                className={cn(SENTENCE_ACTION, 'sentence-action')}
                onClick={() => onAskAssistant({ ref: `s${sentenceNumber}`, label: 'Sentence' })}
                title="Ask the assistant about this sentence"
              >
                <AssistantMark className="h-3.5 w-3.5" />
                Ask
              </button>
            )}
            {comments && sentenceToken?.id && (
              <SentenceComments
                store={comments}
                sentenceId={sentenceToken.id}
                anchorLabel={commentAnchorLabel}
                canWrite={canComment}
                canDeleteAny={canDeleteAnyComment}
                className="sentence-action"
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
