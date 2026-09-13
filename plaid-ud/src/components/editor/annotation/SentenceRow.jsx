import React, { useState, useRef, useMemo, useCallback } from 'react';
import { Check, Undo2, PenLine, Tags } from 'lucide-react';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { Button } from '@ui/components/ui/button';
import { isMachine, needsReview } from '@larc-iu/plaid-client';
import { DependencyTree } from './DependencyTree.jsx';
import { computeArcLayout, buildIndexById } from '../../../utils/arcLayout.js';
import { useTokenPositions } from '../hooks/useTokenPositions.js';
import { RowLabelHeader } from './RowLabelHeader.jsx';
import { TokenColumn } from './TokenColumn.jsx';
import { SentenceComments } from './SentenceComments.jsx';
import { SentenceMetadataDialog } from './SentenceMetadataDialog.jsx';
import './SentenceRow.css';

// Fallback when no per-document visibility is supplied (e.g. historical view):
// show every annotation row. Stable reference so memoized children don't churn.
const ALL_FIELDS_VISIBLE = { lemma: true, xpos: true, upos: true, feats: true };

// Stable empty reference for the project's declared sentence fields, so a
// sentence row memoized on its props doesn't churn when there are none.
const EMPTY_FIELDS = [];

export const SentenceRow = React.memo(
  ({
    sentenceData,
    onAnnotationUpdate,
    onFeatureDelete,
    onRelationCreate,
    onRelationUpdate,
    onRelationDelete,
    onConfirmTokens,
    onDiscardTokens,
    onSentenceMetadata,
    onEditText,
    comments,
    commentAnchorLabel,
    canComment,
    canDeleteAnyComment,
    validators,
    descriptions,
    onPrecedent,
    sentenceFields = EMPTY_FIELDS,
    reviewable = needsReview,
    totalTokensBefore = 0,
    vocab,
    colors,
    visibleFields = ALL_FIELDS_VISIBLE,
    onToggleField,
    onAskAssistant,
    // 0-based here; the assistant addresses sentences from 1, as CoNLL-U does.
    sentenceIndex = 0,
  }) => {
    // Token data is already pre-processed in sentenceData
    const tokenData = sentenceData.tokens;

    // Calculate column widths based on max content width
    const columnWidths = useMemo(() => {
      const widths = tokenData.map((data) => {
        const charWidth = 8; // Approximate width per character
        const padding = 16; // Account for padding
        const minWidth = 40; // Minimum width

        // Token form row is always shown, so it always contributes width.
        const candidates = [minWidth, data.tokenForm.length * charWidth + padding];

        // Only let a field widen the column when it's actually visible — hiding
        // FEATS in particular collapses the over-wide columns it would force.
        if (visibleFields.lemma)
          candidates.push((data.lemma?.value || data.tokenForm).length * charWidth + padding);
        if (visibleFields.xpos)
          candidates.push((data.xpos?.value || '').length * charWidth + padding);
        if (visibleFields.upos)
          candidates.push((data.upos?.value || '').length * charWidth + padding);
        if (visibleFields.feats) {
          const longestFeature = data.feats.reduce((longest, feat) => {
            return feat.value && feat.value.length > longest.length ? feat.value : longest;
          }, '');
          candidates.push(longestFeature ? longestFeature.length * charWidth + padding : minWidth);
        }

        // Return max width for this column
        return Math.max(...candidates);
      });

      return widths;
    }, [tokenData, visibleFields]);

    // Calculate the maximum number of features across all tokens for row height
    const maxFeatures = Math.max(1, ...tokenData.map((data) => data.feats.length));
    // Height of the FEATS row when expanded (grows with the busiest token's tags).
    const featsExpandedHeight = Math.max(30, maxFeatures * 16 + 20);

    // Relations are already pre-processed in sentenceData
    const relations = sentenceData.relations;

    // Lemma spans are already pre-processed in sentenceData
    const lemmaSpans = sentenceData.lemmaSpans;

    // How the arcs stack over this sentence. Computed here rather than inside
    // the tree because the grid has to reserve exactly the height the tree
    // draws into, and it is computed from token order alone — no measurement —
    // so a sentence scrolling into view lays out at its final height at once.
    const arcLayout = useMemo(
      () =>
        computeArcLayout(
          relations,
          buildIndexById(
            tokenData.map((d) => d.token),
            lemmaSpans,
          ),
        ),
      [relations, tokenData, lemmaSpans],
    );

    // Create a text content object that can handle token extraction for DependencyTree
    const textContentProvider = {
      substring: (begin, end) => {
        // Find the token that matches these begin/end positions
        const matchingToken = tokenData.find((t) => t.token.begin === begin && t.token.end === end);
        return matchingToken ? matchingToken.tokenForm : '';
      },
    };

    // Use the token positions hook
    const { tokenPositions, sentenceGridRef, tokenRefs } = useTokenPositions(tokenData, lemmaSpans);

    // Imperative handle into this sentence's dependency tree, for the arrow
    // handoff between the grid and the deprel labels.
    const treeRef = useRef(null);

    // Detect if we're in read-only mode (historical state)
    const isReadOnly = onAnnotationUpdate === null;

    // Calculate tab indices for row-wise navigation across all sentences
    const getTabIndex = useCallback(
      (tokenIndex, field) => {
        const fieldOrder = { lemma: 0, xpos: 1, upos: 2, feats: 3 };
        const tokensInSentence = tokenData.length;

        // Calculate base index for this sentence (all previous sentences)
        const sentenceBaseIndex = totalTokensBefore * 4;

        // Row-wise: field type determines row, token index determines position in row
        const rowIndex = fieldOrder[field];
        const positionInRow = tokenIndex;

        return sentenceBaseIndex + rowIndex * tokensInSentence + positionInRow + 1;
      },
      [tokenData.length, totalTokensBefore],
    );

    // Arrow-key navigation within the sentence's annotation grid.
    // Up/Down step through LEMMA → XPOS → UPOS → FEATS for a fixed token
    // column; Left/Right step through tokens at a fixed field. Every cell's
    // focusable input carries the id `${tokenId}-${field}` (FEATS included —
    // its chip input is `${tokenId}-feats`).
    // Returns true on a successful focus shift so the caller can preventDefault.
    // Hidden rows are excluded so Up/Down skips over them rather than dead-ending.
    const NAV_FIELDS = useMemo(
      () => ['lemma', 'xpos', 'upos', 'feats'].filter((f) => visibleFields[f]),
      [visibleFields],
    );
    const onNavigate = useCallback(
      (field, tokenIndex, dir) => {
        let nextField = field;
        let nextTokenIdx = tokenIndex;
        if (dir === 'up' || dir === 'down') {
          const fi = NAV_FIELDS.indexOf(field);
          if (fi < 0) return false;
          const ni = fi + (dir === 'up' ? -1 : 1);
          if (ni < 0) {
            // Top annotation row + ArrowUp: hand off to this token's deprel label
            // in the tree above. Falls through (dead-ends) if it has no relation.
            return treeRef.current?.focusRelationForToken(tokenData[tokenIndex]?.token.id) || false;
          }
          if (ni >= NAV_FIELDS.length) return false;
          nextField = NAV_FIELDS[ni];
        } else if (dir === 'left' || dir === 'right') {
          const ni = tokenIndex + (dir === 'left' ? -1 : 1);
          if (ni < 0 || ni >= tokenData.length) return false;
          nextTokenIdx = ni;
        } else {
          return false;
        }
        const target = tokenData[nextTokenIdx];
        if (!target) return false;
        const el = document.getElementById(`${target.token.id}-${nextField}`);
        if (!el) return false;
        el.focus();
        return true;
      },
      [tokenData, NAV_FIELDS],
    );

    // ArrowDown out of a deprel label lands on that dependent token's top
    // (first visible) annotation cell — the mirror of the ArrowUp handoff above.
    const focusGridCell = useCallback(
      (tokenId) => {
        const top = NAV_FIELDS[0];
        if (!top) return;
        document.getElementById(`${tokenId}-${top}`)?.focus();
      },
      [NAV_FIELDS],
    );

    // Provenance review: whether this sentence still holds material worth a
    // gesture: on a span (form/lemma/xpos/upos/feats) or a relation.
    //
    // Two scopes, and they are not the same. ACCEPT acts on what this writer
    // reviews (a verifier reviews machine and contributed material, a
    // contributor machine proposals only), so `reviewable` is the writer
    // policy's own predicate. DISCARD acts on MACHINE material whoever is
    // looking: see ConlluDocument.discardTokens for why a contributor's work is
    // never thrown away by a keyboard chord.
    const holds = useCallback(
      (predicate) => {
        const onSpans = tokenData.some((d) =>
          [d.form, d.lemma, d.xpos, d.upos, ...(d.feats || [])].some(
            (span) => !!span && predicate(span.metadata),
          ),
        );
        return onSpans || (relations || []).some((r) => predicate(r.metadata));
      },
      [tokenData, relations],
    );
    const hasInferred = useMemo(() => holds(reviewable), [holds, reviewable]);
    const hasMachine = useMemo(() => holds(isMachine), [holds]);

    // Tokens whose incoming dependency relation still needs this writer's look
    // (the dependent is the relation's TARGET lemma span), for the per-word ✓.
    const inferredRelTokenIds = useMemo(() => {
      const tokenByLemma = new Map();
      for (const d of tokenData) if (d.lemma?.id) tokenByLemma.set(d.lemma.id, d.token.id);
      const ids = new Set();
      for (const r of relations || []) {
        if (!reviewable(r.metadata)) continue;
        const tokenId = tokenByLemma.get(r.target);
        if (tokenId) ids.add(tokenId);
      }
      return ids;
    }, [tokenData, relations, reviewable]);

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

    // Hand over to the Text Editor at this sentence, the mirror of Alt+click on
    // a token there. Undefined when there is no sentence token to land on, so
    // the affordance is simply absent rather than inert.
    const handleEditText = useMemo(
      () => (onEditText && sentenceToken?.id ? () => onEditText(sentenceToken.id) : undefined),
      [onEditText, sentenceToken],
    );

    // Where this sentence sits in the document. Its place, not its `sent_id`:
    // the id is a field like any other and can be edited or imported to
    // anything, while the position is what the pager, the assistant and a
    // person counting down the page all mean by "sentence 7".
    const sentenceNumber = sentenceIndex + 1;

    return (
      <div className="sentence-container">
        {/* The sentence's number, top-left and quiet: it is how you refer to
          this sentence, not something to read. It sits over the tree, which
          covers the whole block, and is click-through so that a mouseup in this
          corner still reaches the arc being drawn underneath. */}
        <div className="sentence-id">{sentenceNumber}</div>

        {/* Dependency tree visualization */}
        <DependencyTree
          ref={treeRef}
          tokens={sentenceData.tokens.map((t) => t.token)}
          relations={relations}
          lemmaSpans={lemmaSpans}
          onRelationCreate={onRelationCreate}
          onRelationUpdate={onRelationUpdate}
          onRelationDelete={onRelationDelete}
          textContent={textContentProvider}
          tokenPositions={tokenPositions}
          deprelColors={colors?.deprel}
          deprelVocab={vocab?.deprel}
          onExitDown={focusGridCell}
          onEditText={handleEditText}
          validateDeprel={validators?.deprel}
          deprelDescriptions={descriptions?.deprel}
          arcLayout={arcLayout}
        />

        {/* Main container with labels and columns */}
        <div
          className="sentence-grid"
          ref={sentenceGridRef}
          style={{ paddingTop: `${arcLayout.gridPaddingTop}px` }}
        >
          {/* Labels column */}
          <div className="labels-column">
            {/* Empty space for token form row */}
            <div className="label-spacer"></div>

            {/* Row headers — always visible, click to expand/collapse */}
            <RowLabelHeader
              field="lemma"
              label="LEMMA"
              expanded={visibleFields.lemma}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="xpos"
              label="XPOS"
              expanded={visibleFields.xpos}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="upos"
              label="UPOS"
              expanded={visibleFields.upos}
              onToggle={onToggleField}
            />
            <RowLabelHeader
              field="feats"
              label="FEATS"
              expanded={visibleFields.feats}
              onToggle={onToggleField}
              style={
                visibleFields.feats
                  ? {
                      minHeight: `${featsExpandedHeight}px`,
                      alignItems: 'flex-start',
                      paddingTop: '6px',
                    }
                  : undefined
              }
            />
          </div>

          {/* Token columns */}
          {tokenData.map((data, index) => (
            <TokenColumn
              key={data.token.id}
              data={data}
              index={index}
              columnWidth={columnWidths[index]}
              getTabIndex={getTabIndex}
              onAnnotationUpdate={onAnnotationUpdate}
              onFeatureDelete={onFeatureDelete}
              onNavigate={onNavigate}
              onConfirmTokens={onConfirmTokens}
              maxFeatures={maxFeatures}
              tokenRefs={tokenRefs}
              isReadOnly={isReadOnly}
              vocab={vocab}
              uposColors={colors?.upos}
              featureInventory={vocab?.featureInventory}
              visibleFields={visibleFields}
              relationInferred={inferredRelTokenIds.has(data.token.id)}
              reviewable={reviewable}
              validators={validators}
              descriptions={descriptions}
              onPrecedent={onPrecedent ? (field) => onPrecedent(field, data) : undefined}
            />
          ))}
        </div>

        {/* Everything the sentence itself offers, BELOW the grid and
          left-aligned with the first token so it reads as belonging to this
          sentence. Two kinds, told apart by weight rather than by position:
          Accept and Discard are outlined and only appear when they have
          something to do, while the four standing actions are one dimmed
          icon-and-label treatment apiece (`sentence-action`) because none of
          them is the thing you came to the sentence to do. The metadata
          disclosure is one of the four: it used to be a bold SENTENCE heading
          on its own line, which made housekeeping the loudest thing under the
          grid. */}
        {(handleEditText ||
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
            {handleEditText && (
              <Button
                className="edit-text-btn sentence-action h-6 gap-1 px-2 text-xs"
                variant="ghost"
                onClick={handleEditText}
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
                onClick={() => onAskAssistant({ ref: `s${sentenceIndex + 1}`, label: 'Sentence' })}
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
      </div>
    );
  },
);
