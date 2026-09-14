import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Check } from 'lucide-react';
import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { provCellTitle, provMark } from '../../../utils/provenanceUi.js';
import { resolveColor } from '../../../utils/udVocab.js';
import { EditableCell } from './EditableCell.jsx';
import { FeaturesCell } from './FeaturesCell.jsx';
import { useEditorSession } from './editorSession.js';

// Token Column component
export const TokenColumn = React.memo(
  ({
    data,
    index,
    columnWidth,
    maxFeatures,
    getTabIndex,
    onNavigate,
    tokenRefs,
    relationInferred,
  }) => {
    const session = useEditorSession();
    const { isReadOnly, onConfirmTokens, onPrecedent, reviewable, visibleFields } = session;
    // Alt+Down asks what the project has said before about a word like this
    // one. Bound to THIS word once: an arrow function made in the render would
    // be a new prop every time, and the cells below are memoized on theirs.
    // LEMMA and XPOS are the two fields with a precedent question of their own,
    // so UPOS is given no gesture rather than one that answers nothing.
    const askPrecedent = useMemo(
      () => (onPrecedent ? (field) => onPrecedent(field, data) : undefined),
      [onPrecedent, data],
    );

    // This word still has machine predictions a human hasn't reviewed (a span on
    // it, or its incoming dependency relation — confirmTokens covers both). When so, a
    // ✓ reveals while you're on THIS word — discoverable at the moment, teaching
    // the Ctrl+Enter shortcut (tooltip). Keyboard focus reveals it via CSS
    // (:focus-within); mouse reveal is JS with a short close-delay so the ✓
    // survives the trip up across the dependency tree's SVG (which otherwise drops
    // a pure-CSS column hover before you can reach it).
    const wordInferred =
      relationInferred ||
      [data.form, data.lemma, data.xpos, data.upos, ...(data.feats || [])].some(
        (span) => !!span && reviewable(span.metadata),
      );
    const showCheck = !isReadOnly && onConfirmTokens && wordInferred;
    const [hoverShow, setHoverShow] = useState(false);
    const hideTimer = useRef(null);
    useEffect(
      () => () => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
      },
      [],
    );
    const revealCheck = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setHoverShow(true);
    };
    const hideCheckSoon = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setHoverShow(false), 250);
    };

    return (
      <div
        className="token-column"
        style={{ width: `${columnWidth}px` }}
        onMouseEnter={showCheck ? revealCheck : undefined}
        onMouseLeave={showCheck ? hideCheckSoon : undefined}
      >
        {/* A native title rather than a tooltip primitive: there is one of these
            per word in a grid that runs to thousands, and every other affordance
            in the grid (each cell, the sentence-level Accept) explains itself the
            same way. */}
        {showCheck && (
          <button
            type="button"
            className="word-accept"
            data-show={hoverShow || undefined}
            tabIndex={-1}
            title="Accept this word's predictions (Ctrl/Cmd+Enter)"
            aria-label="Accept this word's predictions"
            onClick={() => onConfirmTokens([data.token.id])}
          >
            <Check width={12} height={12} />
          </button>
        )}
        {/* Token form (baseline). An unreviewed Form span (MWT components from
            the parser) gets the same marking as the cells. */}
        <div
          className={`token-form${provMark(data.form?.metadata) ? ` token-form--${provMark(data.form.metadata)}` : ''}`}
          title={
            provState(data.form?.metadata) === PROV_STATES.HUMAN
              ? undefined
              : provCellTitle('Form', data.form.metadata)
          }
          ref={(el) => {
            if (el) {
              tokenRefs.current.set(data.token.id, el);
            } else {
              tokenRefs.current.delete(data.token.id);
            }
          }}
        >
          {data.tokenForm}
        </div>

        {/* LEMMA */}
        {visibleFields.lemma ? (
          <div className="annotation-cell">
            <EditableCell
              value={data.lemma?.value}
              tokenId={data.token.id}
              tokenIndex={index}
              field="lemma"
              tokenForm={data.tokenForm}
              tabIndex={getTabIndex(index, 'lemma')}
              columnWidth={columnWidth}
              provMeta={data.lemma?.metadata}
              onNavigate={onNavigate}
              onPrecedent={askPrecedent}
            />
          </div>
        ) : (
          <div className="annotation-cell" />
        )}

        {/* XPOS */}
        {visibleFields.xpos ? (
          <div className="annotation-cell">
            <EditableCell
              value={data.xpos?.value}
              tokenId={data.token.id}
              tokenIndex={index}
              field="xpos"
              tokenForm={data.tokenForm}
              tabIndex={getTabIndex(index, 'xpos')}
              columnWidth={columnWidth}
              provMeta={data.xpos?.metadata}
              onNavigate={onNavigate}
              onPrecedent={askPrecedent}
            />
          </div>
        ) : (
          <div className="annotation-cell" />
        )}

        {/* UPOS */}
        {visibleFields.upos ? (
          <div className="annotation-cell">
            <EditableCell
              value={data.upos?.value}
              tokenId={data.token.id}
              tokenIndex={index}
              field="upos"
              tokenForm={data.tokenForm}
              tabIndex={getTabIndex(index, 'upos')}
              columnWidth={columnWidth}
              cellColor={
                data.upos?.value ? resolveColor(data.upos.value, session.colors?.upos) : undefined
              }
              provMeta={data.upos?.metadata}
              onNavigate={onNavigate}
            />
          </div>
        ) : (
          <div className="annotation-cell" />
        )}

        {/* FEATS */}
        {visibleFields.feats ? (
          <div
            className="features-cell"
            // Tall enough for the longest pill stack in the row, plus the
            // always-present chip input when editable.
            style={{ minHeight: `${Math.max(30, maxFeatures * 16 + (isReadOnly ? 8 : 26))}px` }}
          >
            <FeaturesCell
              feats={data.feats}
              spanIds={data.spanIds.features}
              tokenId={data.token.id}
              tokenIndex={index}
              tabIndex={getTabIndex(index, 'feats')}
              columnWidth={columnWidth}
              onNavigate={onNavigate}
            />
          </div>
        ) : (
          <div className="annotation-cell" />
        )}
      </div>
    );
  },
  // Every prop above is either a value or a reference the sentence row holds
  // steady, so the default shallow comparison is the whole rule. What used to
  // be a hand-written comparator was a second list of the document-wide props,
  // which are now read from the session: a context change re-renders its
  // readers whatever a comparator says, which is what it was for.
);
