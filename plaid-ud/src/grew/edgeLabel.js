// Which graph an edge label speaks of.
//
// Grew reads a DEPS edge that is not also the basic edge as an edge carrying
// `enhanced=yes`, and writes that compactly as an `E:` prefix: `E:nsubj` is
// `1=nsubj, enhanced=yes` (grew.fr/doc/graph). This app keeps those edges in a
// second relation layer (src/domain/enhancedGraph.js), so a label in a request
// is a question put to one layer, the other, or both.
//
// `splitLabel` is the one reading of that, and both consumers go through it:
// compile.js, which turns each side into a clause on its layer, and the local
// matcher, which tests an edge against the side it belongs to. A rewrite finds
// its documents with the first and rewrites them with the second, so the two
// must not drift.
//
//   X -> Y                 either graph
//   X -[nsubj]-> Y         the tree alone: a plain label is the WHOLE label
//   X -[E:nsubj]-> Y       the enhanced graph's extra edges alone
//   X -[nsubj|E:nsubj]-> Y either, each atom on its own side
//   X -[^nsubj]-> Y        any edge but a basic nsubj, so every extra edge too
//   X -[1=nsubj]-> Y       either, `enhanced=yes` narrows to the extras and
//                          `!enhanced` to the tree
//   X -[re"…"]-> Y         a pattern opening with `E:` reads the extras, one
//                          opening with `^` the tree, any other reads both
//
// What Grew has no word for it does not see: a SUPPRESSOR (a basic edge the
// enhanced graph leaves out) is not an edge, and the basic edge under it is an
// ordinary basic edge.

const ENHANCED_PREFIX = 'E:';

export const isEnhancedLabel = (label) => String(label ?? '').startsWith(ENHANCED_PREFIX);

/** The label as the server stores it, without the prefix. */
export const bareLabel = (label) =>
  isEnhancedLabel(label) ? String(label).slice(ENHANCED_PREFIX.length) : String(label ?? '');

/** The label as Grew writes it. */
export const compactLabel = (value, enhanced) =>
  enhanced ? `${ENHANCED_PREFIX}${value ?? ''}` : String(value ?? '');

const ANY = Object.freeze({ type: 'any' });

/**
 * A Label AST as one test per graph: `{ basic, enhanced }`, each a Label with
 * no prefix left in it, or null where the label can match nothing on that side.
 */
export function splitLabel(label) {
  if (!label || label.type === 'any') return { basic: ANY, enhanced: ANY };

  if (label.type === 'list') {
    const basic = label.labels.filter((l) => !isEnhancedLabel(l));
    const enhanced = label.labels.filter(isEnhancedLabel).map(bareLabel);
    const side = (labels) => {
      if (labels.length) return { type: 'list', labels, negated: label.negated };
      // Nothing named on this side: a negation excludes nothing here, and a
      // plain list asks for nothing here.
      return label.negated ? ANY : null;
    };
    return { basic: side(basic), enhanced: side(enhanced) };
  }

  if (label.type === 'regex') {
    const anchored = label.pattern.startsWith('^');
    const rest = anchored ? label.pattern.slice(1) : label.pattern;
    if (rest.startsWith(ENHANCED_PREFIX)) {
      const pattern = (anchored ? '^' : '') + rest.slice(ENHANCED_PREFIX.length);
      return { basic: null, enhanced: { ...label, pattern } };
    }
    return { basic: label, enhanced: anchored ? null : label };
  }

  if (label.type === 'features') {
    const mark = label.feats.filter((f) => f.key === 'enhanced');
    const feats = label.feats.filter((f) => f.key !== 'enhanced');
    const rest = feats.length ? { type: 'features', feats } : ANY;
    let basic = true;
    let enhanced = true;
    for (const f of mark) {
      if (f.neg) enhanced = false;
      else {
        basic = false;
        // `yes` is the only value the feature ever holds.
        if (f.val !== 'yes') enhanced = false;
      }
    }
    return { basic: basic ? rest : null, enhanced: enhanced ? rest : null };
  }

  return { basic: label, enhanced: null };
}
