import React from 'react';

// One node of the graph: the variable small at the left, the concept, and the
// attributes as chips. What is stored is what is seen. A node with no anchor
// is hollow (a state, so a shape and not a pattern). The grip on the bottom
// edge starts an edge drag.
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
}) {
  const worst = problems?.some((p) => p.level === 'error')
    ? 'error'
    : problems?.length
      ? 'warning'
      : null;
  const style = position
    ? { left: `${position.x - position.width / 2}px`, top: `${position.y}px` }
    : { left: 0, top: 0, visibility: 'hidden' };
  const label = [node.var, node.concept].filter(Boolean).join(' ');
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
        {node.var && <span className="umr-node-var">{node.var}</span>}
        <span className="umr-node-concept" dir="auto">
          {node.concept}
        </span>
      </div>
      {node.attrs.length > 0 && (
        <div className="umr-node-attrs">
          {node.attrs.map((a, i) => (
            <span key={i} className="umr-chip" title={`${a.rel} ${a.value}`}>
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
          {docTags.map((t) => (
            <span
              key={t.id}
              className="umr-doc-tag"
              role={onDocTagClick ? 'button' : undefined}
              tabIndex={-1}
              data-triple-id={t.id}
              title={
                onDocTagClick
                  ? 'Click to change. Shift+Backspace in the editor deletes.'
                  : undefined
              }
              onClick={
                onDocTagClick
                  ? (e) => {
                      e.stopPropagation();
                      onDocTagClick(t);
                    }
                  : undefined
              }
            >
              {t.text}
            </span>
          ))}
        </div>
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
