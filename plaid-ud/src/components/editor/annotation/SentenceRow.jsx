import React, { useMemo, useCallback, useRef } from 'react';
import { isMachine } from '@larc-iu/plaid-client';
import { DependencyTree } from './DependencyTree.jsx';
import { EnhancedArcs } from './EnhancedArcs.jsx';
import {
  computeArcLayout,
  computeLowerBand,
  buildIndexById,
  bandTop,
  svgWidth,
} from '../../../utils/arcLayout.js';
import { sentenceArcs, extraEdges } from '../../../domain/enhancedGraph.js';
import { useTokenPositions } from '../hooks/useTokenPositions.js';
import { RowLabelHeader } from './RowLabelHeader.jsx';
import { SentenceActions } from './SentenceActions.jsx';
import { TokenColumn } from './TokenColumn.jsx';
import { useEditorSession } from './editorSession.js';
import { arrowStep } from '@ui/lib/bidi.js';
import './SentenceRow.css';

// One sentence: the dependency tree over it, the annotation grid under that,
// and the row of actions under both. Its props are what only this row can say:
// which sentence, where it sits in the document, what its comment thread is
// captioned with. Everything the whole grid shares comes from the session.
export const SentenceRow = React.memo(
  ({
    sentenceData,
    commentAnchorLabel,
    totalTokensBefore,
    // 0-based here; the assistant addresses sentences from 1, as CoNLL-U does.
    sentenceIndex,
  }) => {
    // What this row itself reads. The dependency tree and the deprel editor
    // render under the same provider and read their own share of it, so nothing
    // about relations or about the DEPREL vocabulary passes through here.
    const { onEditText, onToggleField, reviewable, visibleFields, textDirection } =
      useEditorSession();

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
    // The enhanced layer's rows, and the ones among them that are arcs of their
    // own (`extras`). Those hang in a band of their own UNDER the words, so the
    // tree above stacks the tree alone. What is reviewed is every arc on screen,
    // above or below, which is `arcs`. `relations` stays the tree, for what
    // asks about a word's one head.
    const enhancedRelations = sentenceData.enhancedRelations;
    const extras = useMemo(() => extraEdges(enhancedRelations), [enhancedRelations]);
    const arcs = useMemo(
      () => sentenceArcs({ relations, enhancedRelations }),
      [relations, enhancedRelations],
    );

    // Lemma spans are already pre-processed in sentenceData
    const lemmaSpans = sentenceData.lemmaSpans;

    // How the arcs stack over this sentence. Computed here rather than inside
    // the tree because the grid has to reserve exactly the height the tree
    // draws into, and it is computed from token order alone — no measurement —
    // so a sentence scrolling into view lays out at its final height at once.
    const indexById = useMemo(
      () =>
        buildIndexById(
          tokenData.map((d) => d.token),
          lemmaSpans,
        ),
      [tokenData, lemmaSpans],
    );
    const arcLayout = useMemo(() => computeArcLayout(relations, indexById), [relations, indexById]);
    // The band under the words. Its height is reserved by a spacer in every
    // token column (and the labels column), between the word and its LEMMA, so
    // like the tree's it is known from token order alone, before anything is
    // measured. Zero, and no band, in a sentence with no extra edge.
    const lowerBand = useMemo(() => computeLowerBand(extras, indexById), [extras, indexById]);

    // Use the token positions hook
    const { tokenPositions, sentenceGridRef, tokenRefs } = useTokenPositions(tokenData, lemmaSpans);

    // Imperative handle into this sentence's dependency tree, for the arrow
    // handoff between the grid and the deprel labels.
    const treeRef = useRef(null);
    const lowerRef = useRef(null);

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
          // The cell reports which way the key POINTS. Which token that is
          // depends on the grid: in an RTL sentence the next token is the one
          // further left. See @ui/lib/bidi.js.
          const ni = tokenIndex + arrowStep(dir === 'right', textDirection === 'rtl');
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
      [tokenData, NAV_FIELDS, textDirection],
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
        return onSpans || arcs.some((r) => predicate(r.metadata));
      },
      [tokenData, arcs],
    );
    const hasInferred = useMemo(() => holds(reviewable), [holds, reviewable]);
    const hasMachine = useMemo(() => holds(isMachine), [holds]);

    // Tokens whose incoming dependency relation still needs this writer's look
    // (the dependent is the relation's TARGET lemma span), for the per-word ✓.
    const inferredRelTokenIds = useMemo(() => {
      const tokenByLemma = new Map();
      for (const d of tokenData) if (d.lemma?.id) tokenByLemma.set(d.lemma.id, d.token.id);
      const ids = new Set();
      for (const r of arcs) {
        if (!reviewable(r.metadata)) continue;
        const tokenId = tokenByLemma.get(r.target);
        if (tokenId) ids.add(tokenId);
      }
      return ids;
    }, [tokenData, arcs, reviewable]);

    // Hand over to the Text Editor at this sentence, the mirror of Alt+click on
    // a token there. Undefined when there is no sentence token to land on, so
    // the affordance is simply absent rather than inert.
    const sentenceToken = sentenceData.sentenceToken;
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
      <div className="sentence-scroll" dir={textDirection}>
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
            enhancedRelations={enhancedRelations}
            extras={extras}
            tokenPositions={tokenPositions}
            onExitDown={focusGridCell}
            onEditText={handleEditText}
            arcLayout={arcLayout}
            onEditExtra={(id) => lowerRef.current?.edit(id)}
            onEnterLowerBand={() => lowerRef.current?.focusFirst() || false}
          />

          {/* The enhanced graph's extra edges, under the words. Hung from the
          measured bottom of the word row, and as wide as the tree over it. */}
          {extras.length > 0 && tokenPositions.length > 0 && (
            <EnhancedArcs
              ref={lowerRef}
              relations={extras}
              tokenPositions={tokenPositions}
              layout={lowerBand}
              top={bandTop(tokenPositions[0])}
              minWidth={svgWidth(tokenPositions)}
              onExitDown={focusGridCell}
              onExitUp={(tokenId) =>
                treeRef.current?.focusRelationForToken(tokenId) || treeRef.current?.focusFirst()
              }
            />
          )}

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
              {lowerBand.bandHeight > 0 && (
                <div className="lower-band-spacer" style={{ height: lowerBand.bandHeight }} />
              )}

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
                maxFeatures={maxFeatures}
                getTabIndex={getTabIndex}
                onNavigate={onNavigate}
                tokenRefs={tokenRefs}
                lowerBandHeight={lowerBand.bandHeight}
                relationInferred={inferredRelTokenIds.has(data.token.id)}
              />
            ))}
          </div>

          <SentenceActions
            sentenceData={sentenceData}
            sentenceNumber={sentenceNumber}
            commentAnchorLabel={commentAnchorLabel}
            hasInferred={hasInferred}
            hasMachine={hasMachine}
            onEditText={handleEditText}
          />
        </div>
      </div>
    );
  },
);
