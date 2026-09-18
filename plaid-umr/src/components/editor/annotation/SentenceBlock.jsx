import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { layoutSentence } from '../../../domain/umrLayout.js';
import { keys } from '../../../lib/keymap.js';
import { useCanvasMeasure } from './useCanvasMeasure.js';
import { UmrNode } from './UmrNode.jsx';
import { TokenRow } from './TokenRow.jsx';
import { InlineEditor } from './InlineEditor.jsx';
import { PenmanEditor } from './PenmanEditor.jsx';
import {
  roleOptions,
  normalizeRole,
  conceptOptions,
  wordOptions,
  attributeLineOptions,
  attrsToLine,
  lineToAttrs,
} from './pickers.js';
import './canvas.css';

// Room between rows: lanes for the edges running across, and the label
// floating above each child.
const EDGE_ROOM = 66;

// One sentence: the graph over its words. Nodes are HTML boxes placed by the
// layout, edges an SVG underlay of the same size, the token row beneath.
//
// Every gesture ends in one call on the document. What is in flight between
// two steps of a gesture (a dropped edge waiting for its role, a picked word
// waiting for its concept) lives in `editor` and `mode`, never in the
// document.
export const SentenceBlock = React.memo(function SentenceBlock({
  doc,
  sentence,
  nodesById,
  dataVersion,
  direction = 'ltr',
  readOnly = true,
  frames = null,
  problems = [],
}) {
  const confirm = useConfirm();
  // Problems by the node they name, for the marks; the rest belong to the
  // sentence as a whole.
  const problemsByNode = useMemo(() => {
    const byVar = new Map();
    problems.forEach((p) => {
      if (!p.var) return;
      if (!byVar.has(p.var)) byVar.set(p.var, []);
      byVar.get(p.var).push(p);
    });
    const map = new Map();
    sentence.nodes.forEach((n) => {
      if (n.var && byVar.has(n.var)) map.set(n.id, byVar.get(n.var));
    });
    return map;
  }, [problems, sentence]);
  const errorCount = problems.filter((p) => p.level === 'error').length;
  const warningCount = problems.length - errorCount;
  const [showProblems, setShowProblems] = useState(false);
  // Text mode: the graph as PENMAN in place of the canvas until applied.
  const [textMode, setTextMode] = useState(false);
  const [applying, setApplying] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  // A mode waits for a click: `{ kind: 'anchor' | 'move' | 'reentrancy', nodeId }`.
  const [mode, setMode] = useState(null);
  // An open editor: `{ kind, x, y, ... }`, see askRole and askNewNode.
  const [editor, setEditor] = useState(null);
  // A drag in progress: `{ kind: 'edge' | 'move', sourceId, edgeId, x, y, over }`.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const { canvasRef, wordRef, nodeRef, nodeRefs, columns, sizes } = useCanvasMeasure(
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

  // A focused node that the last edit removed is no longer focused.
  useEffect(() => {
    if (focusedId && !nodesById.has(focusedId)) setFocusedId(null);
  }, [focusedId, nodesById]);

  const active = hoveredId || focusedId;
  const activeNode = active ? nodesById.get(active) : null;
  const litWords = useMemo(() => new Set(activeNode?.wordIds || []), [activeNode]);
  const anchoredWords = useMemo(
    () => new Set(sentence.nodes.flatMap((n) => n.wordIds || [])),
    [sentence],
  );

  // ----- navigation -----

  const focusNode = useCallback(
    (id) => {
      if (!id) return;
      setFocusedId(id);
      nodeRefs.current.get(id)?.focus();
    },
    [nodeRefs],
  );

  const treeEdgeInto = (id) => {
    const node = nodesById.get(id);
    return node?.in.find((e) => layout.tree.treeEdgeIds.has(e.id)) || node?.in[0] || null;
  };
  const treeChildren = (id) =>
    (nodesById.get(id)?.out || [])
      .filter((e) => layout.tree.treeEdgeIds.has(e.id))
      .map((e) => e.target)
      .sort((a, b) => (layout.nodes.get(a)?.x ?? 0) - (layout.nodes.get(b)?.x ?? 0));
  const rowNeighbor = (id, dir) => {
    const me = layout.nodes.get(id);
    if (!me) return null;
    const row = [...layout.nodes.entries()]
      .filter(([, p]) => p.row === me.row)
      .sort((a, b) => a[1].x - b[1].x)
      .map(([nid]) => nid);
    const i = row.indexOf(id);
    return row[i + dir] || null;
  };

  // ----- editors -----

  const positionBelow = (nodeId) => {
    const p = layout.nodes.get(nodeId);
    return p ? { x: p.x - 110, y: p.y + p.height + 6 } : { x: 16, y: 16 };
  };
  const positionAtLabel = (edgeId) => {
    const e = layout.edges.find((x) => x.id === edgeId);
    return e ? { x: e.label.x - 90, y: e.label.y - 12 } : { x: 16, y: 16 };
  };
  // Closing an editor hands focus straight back to the node, before any
  // write is awaited: the next key may come sooner than the server does.
  const closeEditor = () => {
    setEditor(null);
    if (focusedId) setTimeout(() => nodeRefs.current.get(focusedId)?.focus(), 0);
  };

  // The role for an edge about to exist (`sourceId` and `targetId`, or a
  // `newNode` still to be made), or for an existing one (`edgeId`).
  const askRole = (pending, at) =>
    setEditor({ kind: 'role', pending, ...at, value: pending.edgeId ? pending.role : '' });

  // The concept for a node about to exist: a word of the sentence, picked by
  // its number, or any concept typed. Then its role, unless it has no parent.
  const askNewNode = (parentId, wordIds, at, initial = '') =>
    setEditor({ kind: 'new', parentId, wordIds, ...at, value: initial });

  const commitEditor = async (text) => {
    const ed = editor;
    if (!ed) return;
    if (ed.kind === 'role') {
      const role = normalizeRole(text);
      const p = ed.pending;
      if (p.newNode) {
        setEditor(null);
        const r = await doc.createNode({ ...p.newNode, role });
        if (r) focusNode(r.nodeId);
        return;
      }
      closeEditor();
      if (p.edgeId) await doc.setRole(p.edgeId, role);
      else await doc.createEdge(p.sourceId, p.targetId, role);
    } else if (ed.kind === 'new') {
      setEditor(null);
      let wordIds = ed.wordIds;
      let concept = text;
      const picked = /^\d+$/.test(text) ? sentence.words[Number(text) - 1] : null;
      if (picked) {
        wordIds = [picked.id];
        concept = picked.text;
      }
      const newNode = { sentenceIndex: sentence.index, concept, wordIds, parentId: ed.parentId };
      if (ed.parentId) {
        askRole({ newNode }, { x: ed.x, y: ed.y });
      } else {
        const r = await doc.createNode(newNode);
        if (r) focusNode(r.nodeId);
      }
    } else if (ed.kind === 'concept') {
      closeEditor();
      await doc.setConcept(ed.nodeId, text);
    } else if (ed.kind === 'variable') {
      closeEditor();
      await doc.setVariable(ed.nodeId, text);
    } else if (ed.kind === 'attrs') {
      closeEditor();
      await doc.setAttrs(ed.nodeId, lineToAttrs(text));
    }
  };

  // ----- deleting -----

  // Shift+Backspace deletes the edge into the focused node, with what only
  // it reached. Mod+Shift+Backspace deletes the node itself with everything
  // under it. Either asks first when more than one node goes; a leaf goes
  // without a question, since history keeps it.
  const deleteIntoFocused = async (wholeNode) => {
    const node = nodesById.get(focusedId);
    if (!node) return;
    const edge = wholeNode ? null : treeEdgeInto(node.id);
    const doomed = edge
      ? doc.exclusiveDescendants(edge.id)
      : [node, ...node.out.flatMap((e) => doc.exclusiveDescendants(e.id))];
    const next = edge ? edge.source : treeEdgeInto(node.id)?.source || null;
    if (doomed.length > 1) {
      const n = doomed.length;
      const ok = await confirm({
        title: edge
          ? `Delete ${edge.role} and ${n} node${n === 1 ? '' : 's'}`
          : `Delete ${n} nodes`,
        description: `${doomed.map((d) => d.concept).join(', ')}. History keeps them.`,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
    }
    if (edge) await doc.deleteEdge(edge.id);
    else await doc.deleteNode(node.id);
    if (next) focusNode(next);
  };

  // ----- keys -----

  const handleKeyDown = async (e) => {
    if (readOnly || editor || e.isComposing) return;
    if (e.key === 'Escape') {
      if (mode) {
        e.preventDefault();
        setMode(null);
      }
      return;
    }
    const id = focusedId;
    if (!id || !nodesById.has(id)) return;
    const fixedKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'];
    if (fixedKeys.includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.key === 'ArrowUp') focusNode(treeEdgeInto(id)?.source);
      else if (e.key === 'ArrowDown') focusNode(treeChildren(id)[0]);
      else if (e.key === 'ArrowLeft') focusNode(rowNeighbor(id, direction === 'rtl' ? 1 : -1));
      else if (e.key === 'ArrowRight') focusNode(rowNeighbor(id, direction === 'rtl' ? -1 : 1));
      else if (e.key === 'Tab') askNewNode(id, [], positionBelow(id));
      else if (e.key === 'Enter') {
        const node = nodesById.get(id);
        setEditor({ kind: 'concept', nodeId: id, ...positionBelow(id), value: node.concept });
      }
      return;
    }
    const action = keys.which(
      [
        'node.relation',
        'node.attributes',
        'node.variable',
        'node.anchor',
        'node.move',
        'node.reentrancy',
        'node.root',
        'node.delete',
        'node.deleteNode',
        'canvas.newRoot',
      ],
      e,
    );
    if (!action) return;
    e.preventDefault();
    const node = nodesById.get(id);
    switch (action) {
      case 'node.relation': {
        const edge = treeEdgeInto(id);
        if (edge) askRole({ edgeId: edge.id, role: edge.role }, positionAtLabel(edge.id));
        break;
      }
      case 'node.attributes':
        setEditor({
          kind: 'attrs',
          nodeId: id,
          ...positionBelow(id),
          value: attrsToLine(node.attrs),
        });
        break;
      case 'node.variable':
        setEditor({ kind: 'variable', nodeId: id, ...positionBelow(id), value: node.var });
        break;
      case 'node.anchor':
        setMode({ kind: 'anchor', nodeId: id });
        break;
      case 'node.move':
        if (treeEdgeInto(id)) setMode({ kind: 'move', nodeId: id });
        break;
      case 'node.reentrancy':
        setMode({ kind: 'reentrancy', nodeId: id });
        break;
      case 'node.root':
        await doc.setRoot(id);
        break;
      case 'node.delete':
        await deleteIntoFocused(false);
        break;
      case 'node.deleteNode':
        await deleteIntoFocused(true);
        break;
      case 'canvas.newRoot':
        askNewNode(null, [], { x: 16, y: layout.height - 44 });
        break;
      default:
    }
  };

  // ----- clicks in a mode -----

  const clickNode = async (id) => {
    if (readOnly || !mode) {
      focusNode(id);
      return;
    }
    if (mode.kind === 'move') {
      const edge = treeEdgeInto(mode.nodeId);
      setMode(null);
      if (edge && id !== mode.nodeId) await doc.moveEdge(edge.id, id);
      focusNode(mode.nodeId);
    } else if (mode.kind === 'reentrancy') {
      setMode(null);
      if (id !== mode.nodeId) askRole({ sourceId: id, targetId: mode.nodeId }, positionBelow(id));
    } else {
      focusNode(id);
    }
  };

  const clickWord = async (wordId) => {
    if (readOnly || mode?.kind !== 'anchor') return;
    const node = nodesById.get(mode.nodeId);
    if (!node) return;
    const has = node.wordIds.includes(wordId);
    const next = has ? node.wordIds.filter((w) => w !== wordId) : [...node.wordIds, wordId];
    await doc.setAnchor(node.id, next);
  };

  const doubleClickWord = async (wordId) => {
    if (readOnly || mode) return;
    const word = sentence.words.find((w) => w.id === wordId);
    if (!word) return;
    const r = await doc.createNode({
      sentenceIndex: sentence.index,
      concept: word.text,
      wordIds: [wordId],
    });
    if (r) focusNode(r.nodeId);
  };

  // ----- dragging -----

  const graphPoint = (clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
  };
  // What is under the pointer: a node or a word of this block, empty canvas,
  // or nothing of ours.
  const under = (clientX, clientY) => {
    const el = document.elementFromPoint(clientX, clientY);
    const nodeEl = el?.closest?.('[data-node-id]');
    if (nodeEl && canvasRef.current?.contains(nodeEl)) {
      return { kind: 'node', id: nodeEl.dataset.nodeId };
    }
    const wordEl = el?.closest?.('[data-word-id]');
    if (wordEl && canvasRef.current?.parentElement?.contains(wordEl)) {
      return { kind: 'word', id: wordEl.dataset.wordId };
    }
    return canvasRef.current?.contains(el) ? { kind: 'empty' } : null;
  };

  const startDrag = (kind, ids, e) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const p = graphPoint(e.clientX, e.clientY);
    const d = { kind, ...ids, x: p.x, y: p.y, over: null };
    dragRef.current = d;
    setDrag(d);
  };

  // The drag listens on the window (handlers read off a ref), so the hand
  // follows the pointer past the block's edges and the drop lands wherever
  // the pointer is released.
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const p = graphPoint(e.clientX, e.clientY);
      const next = { ...d, x: p.x, y: p.y, over: under(e.clientX, e.clientY) };
      dragRef.current = next;
      setDrag(next);
    };
    const up = async (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      const over = under(e.clientX, e.clientY);
      const p = graphPoint(e.clientX, e.clientY);
      if (d.kind === 'edge') {
        if (over?.kind === 'node' && over.id !== d.sourceId) {
          askRole({ sourceId: d.sourceId, targetId: over.id }, positionBelow(over.id));
        } else if (over?.kind === 'word') {
          const word = sentence.words.find((w) => w.id === over.id);
          const col = columns.get(over.id);
          askNewNode(
            d.sourceId,
            [over.id],
            { x: (col?.x ?? p.x) - 110, y: layout.height - 44 },
            word?.text || '',
          );
        } else if (over?.kind === 'empty') {
          askNewNode(d.sourceId, [], { x: p.x - 110, y: p.y });
        }
      } else if (d.kind === 'move' && over?.kind === 'node') {
        const edge = doc.edge(d.edgeId);
        if (edge && over.id !== edge.source && over.id !== edge.target) {
          await doc.moveEdge(d.edgeId, over.id);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // Armed once per drag; everything it reads comes off refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const handPath = useMemo(() => {
    if (!drag) return null;
    let from;
    if (drag.kind === 'edge') {
      const src = layout.nodes.get(drag.sourceId);
      from = src ? { x: src.x, y: src.y + src.height } : { x: drag.x, y: drag.y };
    } else {
      const e = layout.edges.find((x) => x.id === drag.edgeId);
      from = e ? { x: e.label.x, y: e.label.y } : { x: drag.x, y: drag.y };
    }
    const k = Math.max(16, Math.abs(drag.y - from.y) * 0.6);
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + k}, ${drag.x} ${drag.y - k}, ${drag.x} ${drag.y}`;
  }, [drag, layout]);

  const overNodeId = drag?.over?.kind === 'node' ? drag.over.id : null;
  const overWordId = drag?.over?.kind === 'word' ? drag.over.id : null;

  // The parent whose arguments a role editor lists first.
  const parentConceptOf = (pending) => {
    const id = pending.edgeId
      ? doc.edge(pending.edgeId)?.source
      : pending.sourceId || pending.newNode?.parentId;
    return id ? nodesById.get(id)?.concept : null;
  };

  const editorOptions = (ed) => {
    if (!ed) return [];
    if (ed.kind === 'role') return roleOptions(frames, parentConceptOf(ed.pending));
    if (ed.kind === 'new') {
      const words = ed.wordIds.length
        ? sentence.words.filter((w) => ed.wordIds.includes(w.id))
        : [];
      return [
        ...(ed.wordIds.length ? [] : [{ group: 'Words', items: wordOptions(sentence.words) }]),
        ...conceptOptions(words, frames, ed.typed || ''),
      ];
    }
    if (ed.kind === 'concept') {
      const node = nodesById.get(ed.nodeId);
      return conceptOptions(
        sentence.words.filter((w) => node?.wordIds.includes(w.id)),
        frames,
        ed.typed || '',
      );
    }
    if (ed.kind === 'attrs') return attributeLineOptions();
    return [];
  };

  const modeHint = mode
    ? {
        anchor: 'Click words to anchor to them. Escape when done.',
        move: 'Click the new parent. Escape to cancel.',
        reentrancy: 'Click the second parent. Escape to cancel.',
      }[mode.kind]
    : null;

  return (
    <section
      className={`umr-block${mode ? ` umr-block--mode-${mode.kind}` : ''}`}
      aria-label={`Sentence ${sentence.index}`}
      onKeyDown={handleKeyDown}
    >
      <header className="umr-block-header">
        <span className="umr-block-index">{sentence.index}</span>
        <span className="umr-block-text" dir="auto">
          {sentence.text}
        </span>
        {modeHint && <span className="umr-block-note umr-block-note--mode">{modeHint}</span>}
        {sentence.roots.length > 1 && (
          <span className="umr-block-note">{sentence.roots.length} unconnected graphs</span>
        )}
        {sentence.nodes.length === 0 && !sentence.rawGraph && (
          <span className="umr-block-note">No graph</span>
        )}
        {sentence.rawGraph && (
          <span className="umr-block-note">Graph kept as text, could not be read</span>
        )}
        {!readOnly && (
          <button
            type="button"
            className={`umr-text-toggle${textMode ? ' umr-text-toggle--on' : ''}`}
            aria-pressed={textMode}
            onClick={() => setTextMode((v) => !v)}
          >
            Text
          </button>
        )}
        {problems.length > 0 && (
          <button
            type="button"
            className="umr-problems-toggle"
            aria-expanded={showProblems}
            onClick={() => setShowProblems((v) => !v)}
          >
            {errorCount > 0 && <span className="umr-count umr-count--error">{errorCount}</span>}
            {warningCount > 0 && (
              <span className="umr-count umr-count--warning">{warningCount}</span>
            )}
          </button>
        )}
      </header>
      {showProblems && (
        <ul className="umr-problems">
          {problems.map((p, i) => (
            <li key={i} className={`umr-problem umr-problem--${p.level}`}>
              <span className="umr-problem-code">{p.code}</span>
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {textMode && (
        <PenmanEditor
          initial={doc.penmanOf(sentence.index)}
          applying={applying}
          onApply={async (text) => {
            setApplying(true);
            const changes = await doc.applyPenman(sentence.index, text);
            setApplying(false);
            if (changes !== false) setTextMode(false);
          }}
          onCancel={async (dirty) => {
            if (dirty) {
              const ok = await confirm({
                title: 'Leave the text unapplied',
                description: 'What was typed is not stored.',
                confirmLabel: 'Leave',
                destructive: true,
              });
              if (!ok) return;
            }
            setTextMode(false);
          }}
        />
      )}
      <div
        className="umr-canvas"
        hidden={textMode}
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
            onDoubleClick={(e) => {
              if (readOnly || mode || editor) return;
              if (e.target.closest?.('[data-node-id]')) return;
              const p = graphPoint(e.clientX, e.clientY);
              askNewNode(null, [], { x: p.x - 110, y: p.y });
            }}
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
              {handPath && <path d={handPath} className="umr-edge umr-edge--hand" />}
            </svg>
            {sentence.nodes.map((node, i) => (
              <UmrNode
                key={node.id}
                node={node}
                nodeRef={nodeRef(node.id)}
                position={measured ? layout.nodes.get(node.id) : null}
                focused={focusedId === node.id}
                dropTarget={overNodeId === node.id}
                modeTarget={!!mode && mode.nodeId !== node.id && mode.kind !== 'anchor'}
                onFocus={setFocusedId}
                onClick={clickNode}
                onGripPointerDown={
                  readOnly ? null : (e) => startDrag('edge', { sourceId: node.id }, e)
                }
                tabIndex={i === 0 ? 0 : -1}
                readOnly={readOnly}
                problems={problemsByNode.get(node.id)}
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
                  role={readOnly ? undefined : 'button'}
                  tabIndex={-1}
                  data-edge-id={e.id}
                  onClick={
                    readOnly
                      ? undefined
                      : (ev) => {
                          ev.stopPropagation();
                          askRole({ edgeId: e.id, role: e.role }, positionAtLabel(e.id));
                        }
                  }
                  onPointerDown={
                    readOnly || !e.tree
                      ? undefined
                      : (ev) => {
                          if (ev.button !== 0) return;
                          startDrag('move', { edgeId: e.id }, ev);
                        }
                  }
                  title={readOnly ? undefined : 'Click to change, drag to move under another node'}
                >
                  {e.role}
                </span>
              ))}
            {editor && (
              <InlineEditor
                key={`${editor.kind}:${editor.nodeId || editor.pending?.edgeId || 'new'}`}
                x={editor.x}
                y={editor.y}
                width={editor.kind === 'attrs' ? 320 : 220}
                value={editor.value || ''}
                options={editorOptions(editor)}
                placeholder={
                  {
                    role: 'Relation',
                    new: 'Word number or concept',
                    concept: 'Concept',
                    variable: 'Variable',
                    attrs: ':aspect performance :polarity -',
                  }[editor.kind]
                }
                onCommit={commitEditor}
                onCancel={closeEditor}
                onTyped={(t) => setEditor((ed) => (ed ? { ...ed, typed: t } : ed))}
              />
            )}
          </div>
          <TokenRow
            sentence={sentence}
            wordRef={wordRef}
            anchoredWordIds={anchoredWords}
            highlightedWordIds={litWords}
            dropWordId={overWordId}
            direction={direction}
            onWordClick={readOnly ? null : clickWord}
            onWordDoubleClick={readOnly ? null : doubleClickWord}
            anchorMode={mode?.kind === 'anchor'}
          />
        </div>
      </div>
    </section>
  );
});
