import React, { useState, useRef, useEffect } from 'react';
import { Check } from 'lucide-react';
import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { provCellTitle, provMark } from '../../../utils/provenanceUi.js';
import { resolveColor } from '../../../utils/udVocab.js';
import { EditableCell } from './EditableCell.jsx';
import { FeaturesCell } from './FeaturesCell.jsx';

// Token Column component
export const TokenColumn = React.memo(
  ({
    data,
    index,
    columnWidth,
    getTabIndex,
    onAnnotationUpdate,
    onFeatureDelete,
    onNavigate,
    onConfirmTokens,
    maxFeatures,
    tokenRefs,
    isReadOnly,
    vocab,
    uposColors,
    featureInventory,
    visibleFields,
    relationInferred,
    reviewable,
    validators,
    descriptions,
    onPrecedent,
  }) => {
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
              onUpdate={onAnnotationUpdate}
              onNavigate={onNavigate}
              isReadOnly={isReadOnly}
              mark={provMark(data.lemma?.metadata)}
              onPrecedent={onPrecedent}
              provMeta={data.lemma?.metadata}
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
              onUpdate={onAnnotationUpdate}
              onNavigate={onNavigate}
              isReadOnly={isReadOnly}
              suggestions={vocab?.xpos}
              mark={provMark(data.xpos?.metadata)}
              validate={validators?.xpos}
              descriptions={descriptions?.xpos}
              onPrecedent={onPrecedent}
              provMeta={data.xpos?.metadata}
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
              onUpdate={onAnnotationUpdate}
              onNavigate={onNavigate}
              isReadOnly={isReadOnly}
              suggestions={vocab?.upos}
              cellColor={data.upos?.value ? resolveColor(data.upos.value, uposColors) : undefined}
              mark={provMark(data.upos?.metadata)}
              validate={validators?.upos}
              descriptions={descriptions?.upos}
              provMeta={data.upos?.metadata}
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
              features={data.feats.map((feat) => feat.value)}
              featureMarks={data.feats.map((f) => provMark(f?.metadata))}
              validate={validators?.feats}
              spanIds={{
                features: data.spanIds.features,
              }}
              tokenId={data.token.id}
              tokenIndex={index}
              tabIndex={getTabIndex(index, 'feats')}
              columnWidth={columnWidth}
              onAnnotationUpdate={onAnnotationUpdate}
              onFeatureDelete={onFeatureDelete}
              onNavigate={onNavigate}
              featureInventory={featureInventory}
              featureDescriptions={descriptions?.feats}
              isReadOnly={isReadOnly}
            />
          </div>
        ) : (
          <div className="annotation-cell" />
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.data === nextProps.data &&
      prevProps.index === nextProps.index &&
      prevProps.columnWidth === nextProps.columnWidth &&
      prevProps.maxFeatures === nextProps.maxFeatures &&
      prevProps.onAnnotationUpdate === nextProps.onAnnotationUpdate &&
      prevProps.onFeatureDelete === nextProps.onFeatureDelete &&
      prevProps.onNavigate === nextProps.onNavigate &&
      prevProps.getTabIndex === nextProps.getTabIndex &&
      prevProps.isReadOnly === nextProps.isReadOnly &&
      prevProps.relationInferred === nextProps.relationInferred &&
      // Stable per contributor id (doc.writer memoizes the policy).
      prevProps.reviewable === nextProps.reviewable &&
      // Stable per layerInfo version, like vocab below.
      prevProps.validators === nextProps.validators &&
      prevProps.descriptions === nextProps.descriptions &&
      prevProps.onPrecedent === nextProps.onPrecedent &&
      // Stable identity per layerInfo version, so these don't trigger re-renders.
      prevProps.vocab === nextProps.vocab &&
      prevProps.uposColors === nextProps.uposColors &&
      prevProps.featureInventory === nextProps.featureInventory &&
      prevProps.visibleFields === nextProps.visibleFields
    );
  },
);
