import React from 'react';

// One node of the graph: the variable small at the left, the concept, and the
// attributes as chips. What is stored is what is seen. A node with no anchor
// is hollow (a state, so a shape and not a pattern).
export const UmrNode = React.memo(function UmrNode({
  node,
  position,
  nodeRef,
  focused,
  onFocus,
  tabIndex = -1,
}) {
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
        focused ? 'umr-node--focused' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      tabIndex={tabIndex}
      role="button"
      aria-label={label}
      data-node-id={node.id}
      onFocus={onFocus ? () => onFocus(node.id) : undefined}
    >
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
    </div>
  );
});
