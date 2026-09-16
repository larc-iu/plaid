// Laying out a dependency tree for a citation card.
//
// Not the annotation editor's tree: that one is 850 lines of dragging, inline
// label editing and keyboard navigation over live span objects, measuring its
// words off the DOM. This draws plain CoNLL-U rows, read-only, small enough
// for a docked panel, with its words placed by character count because there
// is nothing to measure. What the two DO share is the geometry — how the arcs
// stack and the shape one is drawn in — which comes from utils/arcLayout.js.
// Read the note at the top of that file before changing the shape of an arc
// here: it is the reason they are flat-topped rather than smooth.
//
// The tree a citation opens on is PARTIAL: the whole sentence, with arcs only
// over the relations the citation named, as the UD documentation draws one
// construction over a sentence. Every arc at once is a hairball on a real
// sentence, which is what the switch under it is for.

import { arcHeight, arcPath, assignLevels } from '../../utils/arcLayout.js';
import { RTL, detectDirection } from '@ui/domain/textDirection.js';

const WORD_GAP = 16; // space between words
// A per-character advance, for SPACING only. The card's words are not drawn in
// a monospaced font (they are the language being documented, and a monospace
// family resolves to a small pool of fonts that drop complex scripts first), so
// this over- or under-estimates a word's real width by a little. Nothing lands
// wrong because of it: each word is centred at its own `x` with
// `textAnchor="middle"` and every arc terminates at that same `x`, so the
// estimate decides the GAPS between words and never the alignment of an arc to
// the word it points at.
const CHAR = 7.2;
const PAD = 10;
const BASELINE = 18; // words sit this far above the bottom
const LABEL_H = 11;

// The card draws at about half the editor's scale — a 9px label over words a
// couple of characters wide — so the stack climbs in smaller steps and turns
// through a tighter corner. The corner has to stay under half the narrowest
// gap between two words, or arcs of different spans would turn at different
// widths, which is what lets them cross.
const CARD_BASE = 14;
const CARD_STEP = 12;
const CARD_CORNER = 8;
const LABEL_LIFT = 3; // a label rides this far above its own arc

// Placed words, laid out from the other end. The editor's tree gets this for
// free because it measures real DOM boxes and the flex container has already
// flipped them; this one places its words by character count, so it has to
// mirror them itself.
//
// Positions only. `arcPath` already handles an arc whose ends run backwards,
// and the stacking works on indexes rather than coordinates, so nothing else
// in this file has to know.
const mirror = (placed, width) =>
  placed.map((w) => ({ ...w, x: width - w.x, left: width - (w.left + w.width) }));

// Each word's x centre and width, from its widest cell.
export const measure = (words) => {
  let x = PAD;
  return words.map((w) => {
    const width = Math.max(String(w.form).length, String(w.deprel || '').length) * CHAR;
    const at = { ...w, x: x + width / 2, left: x, width };
    x += width + WORD_GAP;
    return at;
  });
};

// One arc per word that has a head, plus the root's own stalk. `from`/`to` are
// indexes into the measured words; the root arc has no `from`.
export const arcs = (placed) => {
  const byId = new Map(placed.map((w, i) => [String(w.id), i]));
  const out = [];
  placed.forEach((w, i) => {
    const head = String(w.head ?? '');
    if (head === '' || head === '_') return;
    if (head === '0') {
      out.push({ root: true, to: i, deprel: w.deprel || 'root' });
      return;
    }
    const from = byId.get(head);
    if (from === undefined) return; // a head pointing nowhere draws nothing
    out.push({ root: false, from, to: i, deprel: w.deprel || '' });
  });
  return out;
};

// The arcs a citation named: the relation of each word it marks, which is the
// arc ENDING there, since a word has one head and a dependency is named by its
// dependent. A citation marking no word has singled nothing out, and one whose
// words have no relation to draw would leave a row of words under an empty
// box, so both draw the whole tree.
export const cited = (placed, all) => {
  if (!placed.some((w) => w.focus)) return all;
  const kept = all.filter((a) => placed[a.to]?.focus);
  return kept.length ? kept : all;
};

// The SVG path for one arc, and where its label sits. `baseY` is the line the
// words sit on and `topY` the highest an arc may reach; y grows downward, so
// an arc rising means a SMALLER y.
const placeArc = (placed, arc, height, baseY, topY) => {
  const to = placed[arc.to];
  // Every arc ends AT its dependent, which is what the arrowhead marks: a
  // dependency tree without direction is just a set of lines.
  if (arc.root) {
    return {
      d: `M ${to.x} ${topY} L ${to.x} ${baseY}`,
      labelX: to.x,
      labelY: topY + LABEL_H,
      tipX: to.x,
    };
  }
  const from = placed[arc.from];
  // A stack too deep for the panel flattens against the top rather than
  // drawing outside the box.
  const peak = Math.max(topY, baseY - height);
  return {
    d: arcPath(from.x, to.x, baseY, baseY - peak, CARD_CORNER),
    labelX: (from.x + to.x) / 2,
    labelY: peak - LABEL_LIFT,
    tipX: to.x,
  };
};

// Everything the card needs to draw one sentence: placed words, arcs with
// their paths, and the height the SVG needs. `all` draws every relation rather
// than the cited ones, which is the reader's switch.
//
// `hidden` counts what the partial tree leaves out, and counts it the same in
// both states: it is what the switch is offered on, so a switch that turned
// itself off once pressed would strand the reader in the whole tree.
export const layout = (rows, { maxHeight = 150, all = false, direction = null } = {}) => {
  // A range line (a multi-word token) is not a word of the tree.
  const words = rows.filter((r) => !r.token);
  const measured = measure(words);
  // The card has no document to ask, so the forms themselves are the evidence.
  // A caller that does know says so.
  const dir = direction ?? detectDirection(words.map((w) => w.form).join(' '));
  const edge = measured.at(-1);
  const width = Math.max(80, Math.round((edge?.left ?? 0) + (edge?.width ?? 0) + PAD));
  const placed = dir === RTL ? mirror(measured, width) : measured;
  const every = arcs(placed);
  const narrowed = cited(placed, every);
  const shown = all ? every : narrowed;
  const budget = Math.max(20, maxHeight - BASELINE - LABEL_H - PAD);

  // Each arc sits above whatever is nested inside it. `id` here is the arc's
  // place in `shown`, which is how the level is read back below.
  const { levels, maxLevel } = assignLevels(
    shown
      .map((arc, id) => ({ arc, id }))
      .filter(({ arc }) => !arc.root)
      .map(({ arc, id }) => ({
        id,
        left: Math.min(arc.from, arc.to),
        right: Math.max(arc.from, arc.to),
      })),
  );

  // The stack has to fit the panel, so a deep tree steps in smaller increments.
  // It stays free of crossings either way: that comes from the ORDER the arcs
  // are stacked in, not from the gap between them.
  const base = Math.min(CARD_BASE, budget);
  const step =
    maxLevel > 1 ? Math.max(3, Math.min(CARD_STEP, (budget - base) / (maxLevel - 1))) : CARD_STEP;
  const riseOf = (id) => arcHeight(levels.get(id) || 1, { base, step });

  const tallest = maxLevel ? Math.min(budget, arcHeight(maxLevel, { base, step })) : 0;
  const height = Math.round(Math.min(maxHeight, Math.max(52, tallest + BASELINE + LABEL_H + PAD)));
  const baseY = height - BASELINE;
  const topY = PAD;
  return {
    words: placed,
    arcs: shown.map((a, id) => ({ ...a, ...placeArc(placed, a, riseOf(id), baseY, topY) })),
    hidden: every.length - narrowed.length,
    height,
    width,
    direction: dir,
    baseY,
  };
};
