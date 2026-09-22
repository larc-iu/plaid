import React, { useRef } from 'react';
import { PROV_STATES, provState } from '@larc-iu/plaid-client';

// Provenance, the cross-app convention: a node a machine drafted or a
// contributor made is tinted until somebody settles it, in the two hues
// every app uses. Colour means provenance here, as it does in the igt grid;
// the tint goes the moment a person edits the node, because the edit carries
// the writer's stamp (UmrDocument's `writer`). Marking what needs attention
// rather than what is finished is why a verified node draws plain.
const PROV_CLASS = {
  [PROV_STATES.MACHINE]: 'umr-node--machine',
  [PROV_STATES.CONTRIBUTED]: 'umr-node--contributed',
};
const PROV_TITLE = {
  [PROV_STATES.MACHINE]: 'Machine-made, unverified',
  [PROV_STATES.CONTRIBUTED]: 'Contributed, unverified',
};

// The most document tags a node wears, and the most other ends one tag
// lists. Past either, one fewer and a `+k` that lists them all: nearly every
// node has five or fewer, and the one that does not (an entity 26 others are
// a subset of) would otherwise be a wall.
const MAX_TAGS = 5;
const MAX_ENDS = 4;

// One node of the graph: the variable small at the left, the concept, and the
// attributes as chips. What is stored is what is seen. A node with no anchor
// is hollow (a state, so a shape and not a pattern). The grip on the bottom
// edge starts an edge drag.
//
// Every part a click can edit waits for the node to be focused first (see
// `live` below); the ⋯ and the chain chip do not, since neither edits
// anything on its own.
export const UmrNode = React.memo(function UmrNode({
  node,
  position,
  nodeRef,
  focused,
  dropTarget,
  modeTarget,
  onFocus,
  onClick,
  onGripPointerDown,
  tabIndex = -1,
  readOnly = true,
  problems = null,
  chain = null,
  onChainClick,
  docTags = null,
  onDocTagClick,
  onMenu,
  onAction,
}) {
  // One rule for the whole node: a click FOCUSES it, and a second click on
  // one of its parts opens that part's editor. Without it, a click meant to
  // focus a node landed on whichever chip happened to be under the pointer,
  // and the parts a node shows would each need their own answer to "what
  // does a plain click do here".
  //
  // Read at POINTER-DOWN, because the pointer going down is what focuses the
  // node: by the time the click arrives the node is focused either way, and
  // asking then would make every first click an edit.
  const wasFocused = useRef(false);
  const live = !!onAction && focused;
  const act = (action) => (event) => {
    event.stopPropagation();
    if (wasFocused.current) onAction(action, node.id);
  };
  const worst = problems?.some((p) => p.level === 'error')
    ? 'error'
    : problems?.length
      ? 'warning'
      : null;
  const style = position
    ? { left: `${position.x - position.width / 2}px`, top: `${position.y}px` }
    : { left: 0, top: 0, visibility: 'hidden' };
  const label = [node.var, node.concept].filter(Boolean).join(' ');
  const prov = provState(node.metadata);
  // The tags as drawn: one per relation and direction, the other ends listed
  // in it, so four `:full-affirmative` relations are one tag.
  const tagItems = (() => {
    const byKey = new Map();
    (docTags || []).forEach((t) => {
      const key = `${t.source === node.id ? 'out' : 'in'} ${t.rel}`;
      if (!byKey.has(key)) byKey.set(key, { key, tags: [] });
      byKey.get(key).tags.push(t);
    });
    return [...byKey.values()];
  })();
  const shownItems = tagItems.length > MAX_TAGS ? tagItems.slice(0, MAX_TAGS - 1) : tagItems;
  const hiddenItems = tagItems.slice(shownItems.length).flatMap((i) => i.tags);
  const clickable = !!onDocTagClick && focused;
  const clickTag = (t) =>
    clickable
      ? (e) => {
          e.stopPropagation();
          if (wasFocused.current) onDocTagClick(t);
        }
      : undefined;
  // The rest of a node's relations, past what it shows: read off the
  // tooltip, and listed in full by a click once the node is focused.
  const more = (list, key) => (
    <span
      key={key}
      className="umr-doc-tag-end umr-doc-more"
      role={live ? 'button' : undefined}
      title={list.map((t) => t.text).join('\n')}
      onClick={live ? act('node.docRelations') : undefined}
    >
      +{list.length}
    </span>
  );
  return (
    <div
      ref={nodeRef}
      className={[
        'umr-node',
        node.aligned ? '' : 'umr-node--unaligned',
        node.constant ? 'umr-node--constant' : '',
        node.root ? 'umr-node--root' : '',
        focused ? 'umr-node--focused' : '',
        dropTarget ? 'umr-node--drop' : '',
        modeTarget ? 'umr-node--target' : '',
        PROV_CLASS[prov] || '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      tabIndex={tabIndex}
      role="button"
      aria-label={label}
      title={PROV_TITLE[prov]}
      data-node-id={node.id}
      data-prov={PROV_CLASS[prov] ? prov : undefined}
      onPointerDownCapture={() => {
        wasFocused.current = focused;
      }}
      data-node-var={node.var || undefined}
      onFocus={onFocus ? () => onFocus(node.id) : undefined}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick(node.id);
            }
          : undefined
      }
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(node.id, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {worst && (
        <span
          className={`umr-node-mark umr-node-mark--${worst}`}
          title={problems.map((p) => p.message).join('\n')}
        />
      )}
      {chain && (
        <button
          type="button"
          className="umr-chain"
          style={{ '--chain': chain.color }}
          title={`Coreference chain ${chain.index + 1}: ${chain.size} mentions. Click for the next.`}
          onClick={(e) => {
            e.stopPropagation();
            onChainClick?.(chain.index, node.id);
          }}
          // Enter and Space are the chip's own: they click it. Reaching the
          // node, Enter opened the concept picker instead.
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          }}
        >
          {chain.index + 1}
        </button>
      )}
      <div className="umr-node-head">
        {node.var && (
          <span
            className="umr-node-var"
            role={live ? 'button' : undefined}
            tabIndex={-1}
            title={live ? 'Rename' : undefined}
            onClick={live ? act('node.variable') : undefined}
          >
            {node.var}
          </span>
        )}
        <span
          className="umr-node-concept"
          dir="auto"
          role={live ? 'button' : undefined}
          title={live ? 'Edit the concept' : undefined}
          onClick={live ? act('node.concept') : undefined}
        >
          {node.concept}
        </span>
      </div>
      {node.attrs.length > 0 && (
        <div className="umr-node-attrs">
          {node.attrs.map((a, i) => (
            <span
              key={i}
              className="umr-chip"
              role={live ? 'button' : undefined}
              tabIndex={-1}
              title={live ? 'Edit the attributes' : `${a.rel} ${a.value}`}
              onClick={live ? act('node.attributes') : undefined}
            >
              <span className="umr-chip-rel">{a.rel.replace(/^:/, '')}</span>
              <span className="umr-chip-value" dir="auto">
                {a.value}
              </span>
            </span>
          ))}
        </div>
      )}
      {tagItems.length > 0 && (
        <div className="umr-node-doc">
          {shownItems.map(({ key, tags }) => {
            const [t] = tags;
            // Which end of the triple this node is, marked with a dot where
            // its own variable would be: `● :before s3b` on the source,
            // `s3d :before ●` on the target. A :before read backwards is a
            // real annotation error.
            const out = t.source === node.id;
            const ends = tags.length > MAX_ENDS ? tags.slice(0, MAX_ENDS - 1) : tags;
            const endSpans = ends.map((one, i) => (
              <React.Fragment key={one.id}>
                {i > 0 && ' '}
                {tags.length === 1 ? (
                  one.otherVar
                ) : (
                  <span
                    className="umr-doc-tag-end"
                    role={clickable ? 'button' : undefined}
                    data-triple-id={one.id}
                    onClick={clickTag(one)}
                  >
                    {one.otherVar}
                  </span>
                )}
              </React.Fragment>
            ));
            if (tags.length > ends.length) {
              endSpans.push(' ', more(tags.slice(ends.length), 'more'));
            }
            // One triple: the whole tag is its click. Several: each end is.
            const single = tags.length === 1;
            return (
              <span
                key={key}
                className="umr-doc-tag"
                role={single && clickable ? 'button' : undefined}
                tabIndex={single ? -1 : undefined}
                data-triple-id={single ? t.id : undefined}
                data-group={t.group}
                data-default={(single && t.isDefault) || undefined}
                title={
                  single && clickable
                    ? 'Click to change. Shift+Backspace in the editor deletes.'
                    : undefined
                }
                onClick={single ? clickTag(t) : undefined}
              >
                {out ? (
                  <>
                    ● {t.rel} {endSpans}
                  </>
                ) : (
                  <>
                    {endSpans} {t.rel} ●
                  </>
                )}
              </span>
            );
          })}
          {hiddenItems.length > 0 && (
            <span className="umr-doc-tag umr-doc-tag--more">{more(hiddenItems, 'rest')}</span>
          )}
        </div>
      )}
      {onMenu && (
        <button
          type="button"
          className="umr-more"
          tabIndex={-1}
          aria-label="Actions"
          title="Actions (or right-click)"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(node.id, r.left + r.width / 2, r.bottom);
          }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      )}
      {!readOnly && !node.constant && (
        <span
          className="umr-grip"
          title="Drag to a node, a word or empty space"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            onGripPointerDown?.(e);
          }}
        />
      )}
    </div>
  );
});
