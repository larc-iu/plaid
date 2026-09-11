// Laying out a dependency tree for a citation card.
//
// Not the annotation editor's tree: that one is 862 lines of dragging,
// inline label editing and keyboard navigation over live span objects. This
// draws plain CoNLL-U rows, read-only, small enough for a docked panel. The
// arc-height curve is the editor's, rescaled: a long arc has to clear the
// short ones nested under it without running off the top.

export const WORD_GAP = 16; // space between words
export const CHAR = 7.2; // monospace advance at the card's font size
export const PAD = 10;
export const BASELINE = 18; // words sit this far above the bottom
export const LABEL_H = 11;

// How tall an arc spanning `distance` words rises. The editor's sigmoid, so a
// one-word hop stays low and a long one rises fast at first then flattens.
export const arcHeight = (distance, budget) => {
  const d = Math.abs(distance);
  if (!d) return 0;
  const raw = 1 / (1 + Math.exp(-0.2 * Math.pow(d, 0.8)));
  return Math.max(14, Math.min(budget * ((raw - 0.5) * 2) * 1.6, budget));
};

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
      out.push({ root: true, to: i, deprel: w.deprel || 'root', distance: 0 });
      return;
    }
    const from = byId.get(head);
    if (from === undefined) return; // a head pointing nowhere draws nothing
    out.push({ root: false, from, to: i, deprel: w.deprel || '', distance: i - from });
  });
  return out;
};

// The SVG path for one arc, and where its label sits. `baseY` is the line the
// words sit on and `topY` the highest an arc may reach; y grows downward, so
// an arc rising means a SMALLER y.
export const arcPath = (placed, arc, budget, baseY, topY) => {
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
  const peak = Math.max(topY, baseY - arcHeight(arc.distance, budget));
  return {
    d: `M ${from.x} ${baseY} C ${from.x} ${peak}, ${to.x} ${peak}, ${to.x} ${baseY}`,
    labelX: (from.x + to.x) / 2,
    // Just under the arc's crest, where a cubic sits at about a quarter of the
    // way down from the control points.
    labelY: peak + (baseY - peak) / 4,
    tipX: to.x,
  };
};

// Everything the card needs to draw one sentence: placed words, arcs with
// their paths, and the height the SVG needs.
export const layout = (rows, { maxHeight = 150 } = {}) => {
  // A range line (a multi-word token) is not a word of the tree.
  const words = rows.filter((r) => !r.token);
  const placed = measure(words);
  const all = arcs(placed);
  const budget = Math.max(20, maxHeight - BASELINE - LABEL_H - PAD);
  const tallest = all.reduce((m, a) => Math.max(m, a.root ? 0 : arcHeight(a.distance, budget)), 0);
  const height = Math.round(Math.min(maxHeight, Math.max(52, tallest + BASELINE + LABEL_H + PAD)));
  const baseY = height - BASELINE;
  const topY = PAD;
  const last = placed.at(-1);
  return {
    words: placed,
    arcs: all.map((a) => ({ ...a, ...arcPath(placed, a, budget, baseY, topY) })),
    height,
    width: Math.max(80, Math.round((last?.left ?? 0) + (last?.width ?? 0) + PAD)),
    baseY,
  };
};
