import React, { useRef } from 'react';

// The most document tags a node wears. Past it, one fewer and a `+k` that
// lists them all: nearly every node has five or fewer, and the one that
// does not (an entity 26 others are a subset of) would otherwise be a wall.
const MAX_TAGS = 5;

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
  const shownTags = docTags?.length > MAX_TAGS ? docTags.slice(0, MAX_TAGS - 1) : docTags;
  const hiddenTags = (docTags?.length || 0) - (shownTags?.length || 0);
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
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      tabIndex={tabIndex}
      role="button"
      aria-label={label}
      data-node-id={node.id}
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
      {docTags?.length > 0 && (
        <div className="umr-node-doc">
          {shownTags.map((t) => (
            <span
              key={t.id}
              className="umr-doc-tag"
              role={onDocTagClick && focused ? 'button' : undefined}
              tabIndex={-1}
              data-triple-id={t.id}
              title={
                onDocTagClick && focused
                  ? 'Click to change. Shift+Backspace in the editor deletes.'
                  : undefined
              }
              onClick={
                onDocTagClick && focused
                  ? (e) => {
                      e.stopPropagation();
                      if (wasFocused.current) onDocTagClick(t);
                    }
                  : undefined
              }
            >
              {t.text}
            </span>
          ))}
          {hiddenTags > 0 && (
            <span
              className="umr-doc-tag umr-doc-tag--more"
              role={live ? 'button' : undefined}
              tabIndex={-1}
              // Read-only, or before the node is focused, the rest are
              // read off the tooltip.
              title={docTags
                .slice(shownTags.length)
                .map((t) => t.text)
                .join('\n')}
              onClick={live ? act('node.docRelations') : undefined}
            >
              +{hiddenTags}
            </span>
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
