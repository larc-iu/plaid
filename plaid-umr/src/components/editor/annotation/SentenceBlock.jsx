import React, { useMemo, useState } from 'react';
import { layoutSentence } from '../../../domain/umrLayout.js';
import { useCanvasMeasure } from './useCanvasMeasure.js';
import { UmrNode } from './UmrNode.jsx';
import { TokenRow } from './TokenRow.jsx';
import './canvas.css';

// Room between rows for an edge and the label floating above its child.
const EDGE_ROOM = 44;

// One sentence: the graph over its words. Nodes are HTML boxes placed by the
// layout, edges an SVG underlay of the same size, the token row beneath.
export const SentenceBlock = React.memo(function SentenceBlock({
  sentence,
  nodesById,
  dataVersion,
  direction = 'ltr',
}) {
  const [focusedId, setFocusedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const { canvasRef, wordRef, nodeRef, columns, sizes } = useCanvasMeasure(
    `${dataVersion}:${sentence.index}`,
  );

  const layout = useMemo(() => {
    // Rows are as tall as the tallest node plus room for an edge and its label.
    let tallest = 0;
    sizes.forEach((s) => {
      tallest = Math.max(tallest, s.height);
    });
    const rowHeight = Math.max(36, tallest) + EDGE_ROOM;
    const first = sentence.words[0];
    return layoutSentence(
      sentence,
      nodesById,
      { columns, sizes, sentenceX: first ? (columns.get(first.id)?.x ?? 40) : 40 },
      { rowHeight },
    );
  }, [sentence, nodesById, columns, sizes]);

  const measured = columns.size >= sentence.words.length && sentence.words.length > 0;
  // A node wider than its word overhangs the first or last column. The stage
  // is padded by the overhang, which moves the words and the graph together
  // and so changes no measurement.
  const { width, pad } = useMemo(() => {
    let right = 0;
    let left = 0;
    layout.nodes.forEach((p) => {
      right = Math.max(right, p.x + p.width / 2);
      left = Math.min(left, p.x - p.width / 2);
    });
    return { width: Math.ceil(right + 16), pad: Math.ceil(-left) };
  }, [layout]);

  const active = hoveredId || focusedId;
  const activeNode = active ? nodesById.get(active) : null;
  const litWords = useMemo(() => new Set(activeNode?.wordIds || []), [activeNode]);
  const anchoredWords = useMemo(
    () => new Set(sentence.nodes.flatMap((n) => n.wordIds || [])),
    [sentence],
  );

  return (
    <section className="umr-block" aria-label={`Sentence ${sentence.index}`}>
      <header className="umr-block-header">
        <span className="umr-block-index">{sentence.index}</span>
        <span className="umr-block-text" dir="auto">
          {sentence.text}
        </span>
        {sentence.roots.length > 1 && (
          <span className="umr-block-note">{sentence.roots.length} unconnected graphs</span>
        )}
        {sentence.nodes.length === 0 && <span className="umr-block-note">No graph</span>}
      </header>
      <div
        className="umr-canvas"
        onMouseOver={(e) => {
          const el = e.target.closest?.('[data-node-id]');
          setHoveredId(el ? el.dataset.nodeId : null);
        }}
        onMouseLeave={() => setHoveredId(null)}
      >
        <div className="umr-stage" style={pad ? { paddingLeft: `${pad}px` } : undefined}>
          <div
            className="umr-graph"
            ref={canvasRef}
            style={{ height: `${layout.height}px`, minWidth: `${width}px` }}
          >
            <svg
              className="umr-edges"
              width={Math.max(width, 1)}
              height={layout.height}
              aria-hidden="true"
            >
              {measured &&
                layout.edges.map((e) => (
                  <path
                    key={e.id}
                    d={e.path}
                    className={[
                      'umr-edge',
                      e.tree ? '' : 'umr-edge--reentrant',
                      active && (e.source === active || e.target === active) ? 'umr-edge--lit' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  />
                ))}
            </svg>
            {sentence.nodes.map((node) => (
              <UmrNode
                key={node.id}
                node={node}
                nodeRef={nodeRef(node.id)}
                position={measured ? layout.nodes.get(node.id) : null}
                focused={focusedId === node.id}
                onFocus={setFocusedId}
              />
            ))}
            {measured &&
              layout.edges.map((e) => (
                <span
                  key={e.id}
                  className={[
                    'umr-edge-label',
                    e.tree ? '' : 'umr-edge-label--reentrant',
                    active && (e.source === active || e.target === active)
                      ? 'umr-edge-label--lit'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: `${e.label.x}px`, top: `${e.label.y}px` }}
                >
                  {e.role}
                </span>
              ))}
          </div>
          <TokenRow
            sentence={sentence}
            wordRef={wordRef}
            anchoredWordIds={anchoredWords}
            highlightedWordIds={litWords}
            direction={direction}
          />
        </div>
      </div>
    </section>
  );
});
