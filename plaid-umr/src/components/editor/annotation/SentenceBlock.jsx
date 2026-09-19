import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { layoutSentence } from '../../../domain/umrLayout.js';
import { keys } from '../../../lib/keymap.js';
import { useCanvasMeasure } from './useCanvasMeasure.js';
import { UmrNode } from './UmrNode.jsx';
import { TokenRow } from './TokenRow.jsx';
import { InlineEditor } from './InlineEditor.jsx';
import { AttributePopover } from './AttributePopover.jsx';
import { NodeMenu } from './NodeMenu.jsx';
import { linkedEntries } from '../../../domain/vocabLexicon.js';
import { docTagText } from '../../../domain/sentenceGraph.js';
import { PenmanEditor } from './PenmanEditor.jsx';
import {
  roleOptions,
  normalizeRole,
  conceptOptions,
  wordOptions,
  docRelationOptions,
  groupOfConstant,
  nodeOptions,
  MODAL_CONSTANTS,
  TEMPORAL_CONSTANTS,
} from './pickers.js';
import { DOC_CONSTANTS } from '../../../domain/format/inventory.js';
import './canvas.css';

// Room between rows: lanes for the edges running across, and the label
// floating above each child.
const EDGE_ROOM = 66;

// The margin to the left of every graph, where the document graph's
// constants are pinned, and how the constants stack in it.
// The margin column, and the air between its constants and the graph: a
// chip sitting flush against the root node was the whole of what made the
// top left of a block dense.
const MARGIN = 208;
const CONST_GAP = 28;
const CONST_STEP = 30;
const CONST_TOP = 16;
const ALWAYS_PINNED = ['author', 'root', 'document-creation-time'];

// Every action of a node, for the keymap lookup and for the menu.
const ACTIONS = [
  'node.relation',
  'node.attributes',
  'node.variable',
  'node.anchor',
  'node.move',
  'node.earlier',
  'node.later',
  'node.reentrancy',
  'node.root',
  'node.delete',
  'node.deleteNode',
  'node.coref',
  'node.temporal',
  'node.modal',
  'canvas.newRoot',
];

// The head on an edge, as a marker on its own path. Defined inside the
// block's SVG rather than once for the page, because the colors are custom
// properties of `.umr-block` and a marker elsewhere would not see them;
// hence ids carrying the block's own key.
const Arrow = ({ id, color }) => (
  <marker
    id={id}
    viewBox="0 0 8 8"
    refX="7"
    refY="4"
    markerWidth="5"
    markerHeight="5"
    orient="auto-start-reverse"
    markerUnits="strokeWidth"
  >
    <path d="M 0 1 L 7 4 L 0 7 z" fill={color} />
  </marker>
);

// A chain's color, from its index: hues spread around the wheel.
// Starting away from red, which marks an error.
const chainColor = (index) => `hsl(${(210 + index * 137.5) % 360} 62% 42%)`;

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
  // Jump to a node anywhere in the document. The canvas owns it, because the
  // node may be on a page that is not in the DOM yet.
  goToNode,
  dataVersion,
  direction = 'ltr',
  readOnly = true,
  frames = null,
  // The project's vocabularies as a lexicon (vocabLexicon.js).
  lexicon = null,
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
  // The node menu: which node it is about and where it was asked for, in
  // graph coordinates.
  const [menu, setMenu] = useState(null);
  // The node the open menu is about, readable once `menu` itself has been
  // cleared (the menu closes before it hands focus on).
  const menuNodeRef = useRef(null);
  // How far the canvas has scrolled sideways. The margin sticks to the
  // visible left edge, so a line to a constant ends where the chip is seen.
  const [scrollLeft, setScrollLeft] = useState(0);
  // A mode waits for a click: `{ kind: 'anchor' | 'move' | 'reentrancy', nodeId }`.
  const [mode, setMode] = useState(null);
  // An open editor: `{ kind, x, y, ... }`, see askRole and askNewNode.
  const [editor, setEditor] = useState(null);
  // A drag in progress: `{ kind: 'edge' | 'move', sourceId, edgeId, x, y, over }`.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  // Writes from gestures run one after another: the document refuses a write
  // while one is in flight, and three quick clicks in anchor mode are three
  // writes, not one and two lost.
  const queueRef = useRef(Promise.resolve());
  const run = useCallback((fn) => {
    const next = queueRef.current.then(fn, fn);
    queueRef.current = next.catch(() => {});
    return next;
  }, []);
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

  // The document lane. Constants pinned in the margin: the three every
  // document has, plus any this sentence's triples name. A triple with a
  // constant at one end or both ends in this sentence is drawn; the rest
  // (coreference, a cross-sentence temporal) are listed under the graph.
  const lane = useMemo(() => {
    const names = [...ALWAYS_PINNED];
    const triples = sentence.triples || [];
    triples.forEach((t) => {
      [t.source, t.target].forEach((id) => {
        const n = nodesById.get(id);
        if (n?.constant && !names.includes(n.var)) names.push(n.var);
      });
    });
    const constants = names.map((name, i) => ({
      name,
      node: doc?.constantNode?.(name) || null,
      y: CONST_TOP + i * CONST_STEP,
      used: triples.some((t) => {
        const a = nodesById.get(t.source);
        const b = nodesById.get(t.target);
        return (a?.constant && a.var === name) || (b?.constant && b.var === name);
      }),
    }));
    const constY = new Map(constants.map((c) => [c.name, c.y]));
    const drawn = [];
    const listed = [];
    triples.forEach((t) => {
      const a = nodesById.get(t.source);
      const b = nodesById.get(t.target);
      if (!a || !b) return;
      const here = (n) => !n.constant && n.sentence === sentence.index;
      if ((a.constant && here(b)) || (b.constant && here(a))) {
        drawn.push({
          ...t,
          kind: 'margin',
          node: a.constant ? b : a,
          constant: a.constant ? a : b,
        });
      } else if (here(a) && here(b) && t.group !== 'coref') {
        drawn.push({ ...t, kind: 'inner', a, b });
      } else {
        listed.push({ ...t, a, b });
      }
    });
    return { constants, constY, drawn, listed };
  }, [sentence, nodesById, doc]);

  // The document edges of the ACTIVE node, in STAGE coordinates (the
  // margin's origin). At rest the document level is tags on the nodes and
  // nothing else: every triple drawn as a curve, on a long sentence, was the
  // tangle. Focus or hover a node and its own relations light up, a line to
  // the margin constant or an arc to the other node, with the label on the
  // arc.
  const docEdges = useMemo(() => {
    if (!measured || !active) return [];
    const dx = MARGIN + pad;
    return lane.drawn
      .map((t) => {
        if (t.kind === 'margin') {
          if (t.node.id !== active) return null;
          const p = layout.nodes.get(t.node.id);
          if (!p) return null;
          const x1 = p.x - p.width / 2 + dx;
          const y1 = p.y + p.height / 2;
          const x2 = MARGIN - CONST_GAP + scrollLeft;
          const y2 = lane.constY.get(t.constant.var) + 11;
          const k = Math.max(24, Math.abs(x1 - x2) / 2);
          // Drawn in the triple's own direction, so the head at the far end
          // points where the relation does. Nearly every one of these runs
          // FROM the constant (`author :full-affirmative x`).
          const fromNode = t.source === t.node.id;
          return {
            ...t,
            path: fromNode
              ? `M ${x1} ${y1} C ${x1 - k} ${y1}, ${x2 + k} ${y2}, ${x2} ${y2}`
              : `M ${x2} ${y2} C ${x2 + k} ${y2}, ${x1 - k} ${y1}, ${x1} ${y1}`,
          };
        }
        if (t.a.id !== active && t.b.id !== active) return null;
        const pa = layout.nodes.get(t.a.id);
        const pb = layout.nodes.get(t.b.id);
        if (!pa || !pb) return null;
        const x1 = pa.x + dx;
        const x2 = pb.x + dx;
        let lift = 18 + Math.abs(x2 - x1) / 8;
        // The arc rises over the two nodes when there is room above them and
        // dips under them when there is not (a pair on the top row), so it
        // is never cut off by the top of the stage.
        const above = Math.min(pa.y, pb.y) - lift >= 6;
        const y1 = above ? pa.y : pa.y + pa.height;
        const y2 = above ? pb.y : pb.y + pb.height;
        if (!above) lift = -lift;
        // No label on the arc either: each end wears the relation as a tag,
        // and a label floating mid-arc landed on whatever node was under it.
        return {
          ...t,
          path: `M ${x1} ${y1} C ${x1} ${y1 - lift}, ${x2} ${y2 - lift}, ${x2} ${y2}`,
        };
      })
      .filter(Boolean);
  }, [lane, layout, measured, pad, active, scrollLeft]);

  // The document triples of each node, as tags: `author :full-affirmative`
  // for a margin constant, and for a pair of this sentence's nodes the
  // triple with the node's own variable left out, `:before s3b` on the
  // source and `s3d :before` on the target.
  const docTagsByNode = useMemo(() => {
    const map = new Map();
    const tag = (nodeId, t, text) => {
      if (!map.has(nodeId)) map.set(nodeId, []);
      map.get(nodeId).push({ id: t.id, rel: t.rel, group: t.group, text });
    };
    lane.drawn.forEach((t) => {
      if (t.kind === 'margin') tag(t.node.id, t, docTagText(t, t.node.id, t.constant.var));
      else {
        tag(t.a.id, t, docTagText(t, t.a.id, t.b.var));
        tag(t.b.id, t, docTagText(t, t.b.id, t.a.var));
      }
    });
    return map;
  }, [lane]);

  const chainOf = (node) => {
    if (node.chain == null) return null;
    const chain = doc?.graph?.chains?.[node.chain];
    return chain
      ? { index: chain.index, color: chainColor(chain.index), size: chain.nodes.length }
      : null;
  };
  const onChainClick = (index, nodeId) => {
    const chain = doc.graph.chains[index];
    if (!chain) return;
    const i = chain.nodes.indexOf(nodeId);
    goToNode(chain.nodes[(i + 1) % chain.nodes.length]);
  };
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

  // A document-level triple about to exist (`triple: { source, target,
  // group }`, either end a node id or a constant's name), or an existing one
  // (`tripleId`).
  const askDocRole = (pending, at) =>
    setEditor({ kind: 'docRole', pending, ...at, value: pending.tripleId ? pending.role : '' });

  // Pick the other end of a document-level relation: a constant or a node
  // anywhere in the document.
  const askPick = (group, nodeId) =>
    setEditor({ kind: 'pick', group, nodeId, ...positionBelow(nodeId), value: '' });

  const commitEditor = async (text, option = null) => {
    const ed = editor;
    if (!ed) return;
    if (ed.kind === 'docRole') {
      const rel = normalizeRole(text);
      const p = ed.pending;
      closeEditor();
      if (p.tripleId) await run(() => doc.setTripleRelation(p.tripleId, rel));
      else {
        await run(() => doc.createTriple({ ...p.triple, rel, sentenceIndex: sentence.index }));
      }
      return;
    }
    if (ed.kind === 'pick') {
      const name = String(text).trim().split(/\s+/)[0];
      setEditor(null);
      const at = positionBelow(ed.nodeId);
      if (DOC_CONSTANTS.includes(name)) {
        askDocRole({ triple: { source: name, target: ed.nodeId, group: ed.group } }, at);
        return;
      }
      // The option picked carries its node; typed text names a variable,
      // which is unique by convention only.
      let other = option?.nodeId ? nodesById.get(option.nodeId) : null;
      if (!other) {
        const named = [...nodesById.values()].filter((n) => n.var === name && !n.constant);
        if (named.length > 1) {
          doc.setError(`${name} names ${named.length} nodes. Pick one from the list.`);
          closeEditor();
          return;
        }
        other = named[0] || null;
      }
      if (!other || other.id === ed.nodeId) {
        closeEditor();
        return;
      }
      // A coreference or temporal relation runs from this node to the other;
      // a modal one runs from the conceiver picked to this node.
      const triple =
        ed.group === 'modal'
          ? { source: other.id, target: ed.nodeId, group: 'modal' }
          : { source: ed.nodeId, target: other.id, group: ed.group };
      askDocRole({ triple }, at);
      return;
    }
    if (ed.kind === 'role') {
      const role = normalizeRole(text);
      const p = ed.pending;
      if (p.newNode) {
        setEditor(null);
        const r = await run(() => doc.createNode({ ...p.newNode, role }));
        if (r) focusNode(r.nodeId);
        return;
      }
      closeEditor();
      if (p.edgeId) await run(() => doc.setRole(p.edgeId, role));
      else await run(() => doc.createEdge(p.sourceId, p.targetId, role));
    } else if (ed.kind === 'new') {
      setEditor(null);
      let wordIds = ed.wordIds;
      let concept = text;
      // A number names a word only when no word was dropped on: a word whose
      // form is a numeral is a concept like any other.
      const picked =
        !ed.wordIds.length && /^\d+$/.test(text) ? sentence.words[Number(text) - 1] : null;
      if (picked) {
        wordIds = [picked.id];
        concept = picked.text;
      }
      const newNode = { sentenceIndex: sentence.index, concept, wordIds, parentId: ed.parentId };
      if (ed.parentId) {
        askRole({ newNode }, { x: ed.x, y: ed.y });
      } else {
        const r = await run(() => doc.createNode(newNode));
        if (r) focusNode(r.nodeId);
      }
    } else if (ed.kind === 'concept') {
      closeEditor();
      await run(() => doc.setConcept(ed.nodeId, text));
    } else if (ed.kind === 'variable') {
      closeEditor();
      await run(() => doc.setVariable(ed.nodeId, text));
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
    // A root has no edge to delete; the node itself is the other chord's.
    if (!wholeNode && !edge) return;
    const doomed = edge ? doc.exclusiveDescendants(edge.id) : [node, ...doc.orphanedBy(node.id)];
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
    if (edge) await run(() => doc.deleteEdge(edge.id));
    else await run(() => doc.deleteNode(node.id));
    if (next) focusNode(next);
  };

  // ----- keys -----

  const handleKeyDown = async (e) => {
    if (readOnly || editor || menu || e.isComposing) return;
    // A text box inside the block owns its keys. The bare letters below are
    // `outsideText` in the table, and this is where that is kept.
    if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    // Shift+Tab is the way out of the block for a keyboard.
    if (e.key === 'Tab' && e.shiftKey) return;
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
      else if (e.key === 'Enter') await runAction('node.concept', id);
      return;
    }
    const action = keys.which(ACTIONS, e);
    if (!action) return;
    e.preventDefault();
    await runAction(action, id);
  };

  // What each action DOES, however it was asked for: a key, or the node's
  // menu. One definition, so a gesture cannot come to mean two things
  // depending on which way it was reached.
  const runAction = async (action, id = focusedId) => {
    const node = nodesById.get(id);
    if (!node) return;
    switch (action) {
      case 'node.concept':
        setEditor({ kind: 'concept', nodeId: id, ...positionBelow(id), value: node.concept });
        break;
      case 'node.relation': {
        const edge = treeEdgeInto(id);
        if (edge) askRole({ edgeId: edge.id, role: edge.role }, positionAtLabel(edge.id));
        break;
      }
      case 'node.attributes':
        setEditor({ kind: 'attrs', nodeId: id, ...positionBelow(id) });
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
      case 'node.earlier':
      case 'node.later': {
        const edge = treeEdgeInto(id);
        if (edge) await run(() => doc.shiftEdge(edge.id, action === 'node.earlier' ? -1 : 1));
        break;
      }
      case 'node.reentrancy':
        setMode({ kind: 'reentrancy', nodeId: id });
        break;
      case 'node.root':
        await run(() => doc.setRoot(id));
        break;
      case 'node.delete':
        await deleteIntoFocused(false);
        break;
      case 'node.deleteNode':
        await deleteIntoFocused(true);
        break;
      case 'node.coref':
        askPick('coref', id);
        break;
      case 'node.temporal':
        askPick('temporal', id);
        break;
      case 'node.modal':
        askPick('modal', id);
        break;
      case 'canvas.newRoot':
        askNewNode(null, [], { x: 16, y: layout.height - 44 });
        break;
      default:
    }
  };

  // Right-click a node, or click its ⋯: the menu, about that node, at the
  // point it was asked for. The node takes focus first, so every action runs
  // against the same node the keyboard would.
  const openMenu = (id, clientX, clientY) => {
    if (readOnly || mode) return;
    focusNode(id);
    menuNodeRef.current = id;
    setMenu({ id, ...graphPoint(clientX, clientY) });
  };

  // What the menu greys out: an action that has nothing to act on. A root
  // has no relation to a parent, a first child cannot move earlier.
  const menuDisabled = (() => {
    if (!menu) return null;
    const node = nodesById.get(menu.id);
    if (!node) return null;
    const edge = treeEdgeInto(menu.id);
    const siblings = edge
      ? [...(nodesById.get(edge.source)?.out || [])].sort((a, b) => a.order - b.order)
      : [];
    const at = edge ? siblings.findIndex((x) => x.id === edge.id) : -1;
    return {
      'node.relation': !edge,
      'node.move': !edge,
      'node.earlier': at <= 0,
      'node.later': at < 0 || at >= siblings.length - 1,
      'node.root': !!node.root,
      'node.delete': !edge,
    };
  })();

  // ----- clicks in a mode -----

  const clickNode = async (id) => {
    if (readOnly || !mode) {
      focusNode(id);
      return;
    }
    if (mode.kind === 'move') {
      const edge = treeEdgeInto(mode.nodeId);
      setMode(null);
      if (edge && id !== mode.nodeId) await run(() => doc.moveEdge(edge.id, id));
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
    await run(() => {
      // Read at run time: an earlier click in the queue may have moved it.
      const current = doc.node(node.id);
      if (!current) return false;
      const has = current.wordIds.includes(wordId);
      const next = has ? current.wordIds.filter((w) => w !== wordId) : [...current.wordIds, wordId];
      return doc.setAnchor(current.id, next);
    });
  };

  // A parentless node over a word. The concept picker opens prefilled with
  // the word, the same as dropping a grip on it: an inflected surface form
  // is almost never the concept, and the frame file's senses of the word are
  // the first thing the picker offers. Enter takes the word as typed.
  const doubleClickWord = (wordId) => {
    if (readOnly || mode) return;
    const word = sentence.words.find((w) => w.id === wordId);
    if (!word) return;
    const col = columns.get(wordId);
    askNewNode(null, [wordId], { x: (col?.x ?? 16) - 110, y: layout.height - 44 }, word.text);
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
    if (nodeEl) return { kind: 'foreign', id: nodeEl.dataset.nodeId };
    const constEl = el?.closest?.('[data-const-name]');
    if (constEl) return { kind: 'const', name: constEl.dataset.constName };
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
    // Ctrl/Cmd, read once as the drag begins, makes the drop a temporal
    // relation between two events rather than an edge.
    const d = { kind, ...ids, x: p.x, y: p.y, over: null, doc: e.ctrlKey || e.metaKey };
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
        if (over?.kind === 'const') {
          const group = groupOfConstant(over.name);
          askDocRole(
            { triple: { source: over.name, target: d.sourceId, group } },
            positionBelow(d.sourceId),
          );
        } else if (over?.kind === 'foreign') {
          // Onto another sentence's node: temporal with Ctrl/Cmd, else coreference.
          const group = d.doc ? 'temporal' : 'coref';
          askDocRole(
            { triple: { source: d.sourceId, target: over.id, group } },
            positionBelow(d.sourceId),
          );
        } else if (over?.kind === 'node' && over.id !== d.sourceId && d.doc) {
          askDocRole(
            { triple: { source: d.sourceId, target: over.id, group: 'temporal' } },
            positionBelow(over.id),
          );
        } else if (over?.kind === 'node' && over.id !== d.sourceId) {
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
          await run(() => doc.moveEdge(d.edgeId, over.id));
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
  const overConst = drag?.over?.kind === 'const' ? drag.over.name : null;

  // The parent whose arguments a role editor lists first.
  const parentConceptOf = (pending) => {
    const id = pending.edgeId
      ? doc.edge(pending.edgeId)?.source
      : pending.sourceId || pending.newNode?.parentId;
    return id ? nodesById.get(id)?.concept : null;
  };

  // The vocabulary entries the given words are linked to, on the words
  // themselves or on their morphemes, and the lexicon for what is typed.
  const vocabFor = (words) => {
    if (!lexicon || !lexicon.entries.length) return null;
    const within = (m) => words.some((w) => m.begin >= w.begin && m.end <= w.end);
    const tokenIds = [
      ...words.map((w) => w.id),
      ...(sentence.morphemes || []).filter(within).map((m) => m.id),
    ];
    return { linked: linkedEntries(lexicon, doc?.vocabLinks, tokenIds), lexicon };
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
        ...conceptOptions(words, frames, ed.typed || '', vocabFor(words)),
      ];
    }
    if (ed.kind === 'concept') {
      const node = nodesById.get(ed.nodeId);
      const words = sentence.words.filter((w) => node?.wordIds.includes(w.id));
      return conceptOptions(words, frames, ed.typed || '', vocabFor(words));
    }
    if (ed.kind === 'docRole') {
      const group = ed.pending.tripleId ? ed.pending.group : ed.pending.triple.group;
      return docRelationOptions(group);
    }
    if (ed.kind === 'pick') {
      const constants =
        ed.group === 'modal' ? MODAL_CONSTANTS : ed.group === 'temporal' ? TEMPORAL_CONSTANTS : [];
      return [
        ...(constants.length ? [{ group: 'Constants', items: constants }] : []),
        ...nodeOptions(doc.graph, ed.nodeId),
      ];
    }
    return [];
  };

  // Unique to this block, so two blocks' markers cannot collide.
  const arrows = `umr-arrow-${sentence.tokenId}`;

  const modeHint = mode
    ? {
        anchor: 'Click words to anchor to them.',
        move: 'Click the new parent.',
        reentrancy: 'Click the second parent.',
      }[mode.kind]
    : null;

  return (
    <section
      className={`umr-block${mode ? ` umr-block--mode-${mode.kind}` : ''}`}
      aria-label={`Sentence ${sentence.index}`}
      data-sentence-index={sentence.index}
      onKeyDown={handleKeyDown}
    >
      <header className="umr-block-header">
        <span className="umr-block-index">{sentence.index}</span>
        <span className="umr-block-text" dir="auto">
          {sentence.text}
        </span>
        {modeHint && (
          <span className="umr-block-note umr-block-note--mode">
            {modeHint}
            {/* Escape leaves a mode, and anchor mode ends no other way: a
                click there is a word, not a way out. */}
            <button
              type="button"
              className="umr-mode-end"
              onClick={() => {
                const id = mode.nodeId;
                setMode(null);
                focusNode(id);
              }}
            >
              {mode.kind === 'anchor' ? 'Done' : 'Cancel'}
            </button>
          </span>
        )}
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
            const changes = await run(() => doc.applyPenman(sentence.index, text));
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
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        onMouseOver={(e) => {
          const el = e.target.closest?.('[data-node-id]');
          setHoveredId(el ? el.dataset.nodeId : null);
        }}
        onMouseLeave={() => setHoveredId(null)}
      >
        <div
          className="umr-stage"
          style={{
            paddingLeft: `${MARGIN + pad}px`,
            '--umr-margin': `${MARGIN}px`,
            '--umr-pad': `${pad}px`,
          }}
        >
          <div className="umr-margin" aria-label="Document constants">
            {lane.constants.map((c) => (
              <span
                key={c.name}
                className={[
                  'umr-const',
                  c.used ? 'umr-const--used' : '',
                  overConst === c.name ? 'umr-const--drop' : '',
                  // A constant this sentence does not use is ink on every
                  // block for a target nobody is aiming at. It comes back
                  // when a node is focused or a drag is under way, which is
                  // when one might be. Its place is held either way, so
                  // nothing moves as it appears.
                  c.used || active || drag ? '' : 'umr-const--idle',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ position: 'absolute', top: `${c.y}px`, right: `${CONST_GAP}px` }}
                data-const-name={c.name}
                title={
                  readOnly
                    ? undefined
                    : `Drag a node here for a ${groupOfConstant(c.name)} relation`
                }
              >
                {c.name}
              </span>
            ))}
          </div>
          <svg
            className="umr-doc-edges"
            width={MARGIN + pad + Math.max(width, 1)}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <Arrow id={`${arrows}-doc`} color="var(--umr-doc)" />
            </defs>
            {docEdges.map((t) => (
              <path
                key={t.id}
                d={t.path}
                className="umr-doc-edge"
                markerEnd={`url(#${arrows}-doc)`}
              />
            ))}
          </svg>
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
              <defs>
                <Arrow id={`${arrows}-edge`} color="var(--umr-edge)" />
                <Arrow id={`${arrows}-lit`} color="var(--umr-edge-lit)" />
              </defs>
              {measured &&
                layout.edges.map((e) => {
                  const lit = active && (e.source === active || e.target === active);
                  return (
                    <path
                      key={e.id}
                      d={e.path}
                      className={[
                        'umr-edge',
                        e.tree ? '' : 'umr-edge--reentrant',
                        lit ? 'umr-edge--lit' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      // Which way the relation runs. A tree edge's direction
                      // is legible from the rows alone; a re-entrant one's is
                      // not, since it can point anywhere.
                      markerEnd={`url(#${arrows}-${lit ? 'lit' : 'edge'})`}
                    />
                  );
                })}
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
                // The mouse paths for what a key does. They are off during a
                // mode, when a click on a node means "this one" instead.
                onMenu={readOnly || mode ? null : openMenu}
                onAction={readOnly || mode ? null : runAction}
                tabIndex={i === 0 ? 0 : -1}
                readOnly={readOnly}
                problems={problemsByNode.get(node.id)}
                chain={chainOf(node)}
                onChainClick={onChainClick}
                docTags={docTagsByNode.get(node.id)}
                onDocTagClick={
                  readOnly
                    ? undefined
                    : (t) =>
                        askDocRole(
                          { tripleId: t.id, role: t.rel, group: t.group },
                          positionBelow(node.id),
                        )
                }
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
            <NodeMenu
              at={menu}
              disabled={menuDisabled}
              onAction={(action) => runAction(action, menu.id)}
              onClose={() => setMenu(null)}
              // Once the menu has gone: whatever it opened takes focus, and
              // failing that the node, so a mode's Escape and the next
              // shortcut reach the block.
              onClosed={() =>
                requestAnimationFrame(() => {
                  // The inline editor is in place, the attribute picker is
                  // portaled out of the canvas (it would be clipped there),
                  // so they are looked for in different places. Focusing the
                  // node instead would dismiss the picker as an interaction
                  // outside it.
                  const opened =
                    canvasRef.current?.querySelector('.umr-inline-editor input') ||
                    document.querySelector('.umr-attr-popover button');
                  if (opened) opened.focus();
                  else focusNode(menuNodeRef.current);
                })
              }
            />
            {editor?.kind === 'attrs' && nodesById.has(editor.nodeId) && (
              <AttributePopover
                nodeId={editor.nodeId}
                attrs={nodesById.get(editor.nodeId).attrs}
                onChange={(attrs) => run(() => doc.setAttrs(editor.nodeId, attrs))}
                onClose={closeEditor}
              />
            )}
            {editor && editor.kind !== 'attrs' && (
              <InlineEditor
                key={`${editor.kind}:${editor.nodeId || editor.pending?.edgeId || editor.pending?.tripleId || 'new'}`}
                x={editor.x}
                y={editor.y}
                value={editor.value || ''}
                options={editorOptions(editor)}
                placeholder={
                  {
                    role: 'Relation',
                    docRole: 'Relation',
                    pick: 'Variable or constant',
                    new: 'Word number or concept',
                    concept: 'Concept',
                    variable: 'Variable',
                  }[editor.kind]
                }
                onCommit={commitEditor}
                onCancel={closeEditor}
                onDelete={
                  editor.kind === 'role' && editor.pending.edgeId
                    ? () => {
                        const id = editor.pending.edgeId;
                        closeEditor();
                        run(() => doc.deleteEdge(id, { subtree: false }));
                      }
                    : editor.kind === 'docRole' && editor.pending.tripleId
                      ? () => {
                          const id = editor.pending.tripleId;
                          closeEditor();
                          run(() => doc.deleteTriple(id));
                        }
                      : undefined
                }
                onTyped={(t) => setEditor((ed) => (ed ? { ...ed, typed: t } : ed))}
              />
            )}
          </div>
          {lane.listed.length > 0 && (
            <div className="umr-doc-list" aria-label="Document-level relations">
              {lane.listed.map((t) => (
                <span
                  key={t.id}
                  className="umr-doc-chip"
                  role={readOnly ? undefined : 'button'}
                  tabIndex={-1}
                  data-triple-id={t.id}
                  onClick={
                    readOnly
                      ? undefined
                      : (ev) => {
                          ev.stopPropagation();
                          askDocRole(
                            { tripleId: t.id, role: t.rel, group: t.group },
                            { x: 16, y: layout.height - 44 },
                          );
                        }
                  }
                >
                  {t.a.var} {t.rel} {t.b.var}
                </span>
              ))}
            </div>
          )}
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
