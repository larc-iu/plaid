// A plain word lookup, for people who do not write Grew.
//
// Grew is stronger for structure and worse for "where does `dog` occur". This
// compiles a field, a match type and a string into a Grew PATTERN string, which
// the existing compiler then turns into QL. Going through Grew rather than
// straight to QL is deliberate: there is then ONE compiler, one set of
// warnings, one residue of unsupported things, and the box can hand its pattern
// to the Grew box so a quick search is the first draft of a real one.
//
// The patterns it writes are the ones a UD annotator would write by hand:
//
//   form contains "dog"   ->  pattern { W [form=re"dog"] }
//   upos is "NOUN"        ->  pattern { W [upos="NOUN"] }
//   feats regex "Number"  ->  pattern { W [Number=re"..."] }

/** The fields a quick search can look in, in the order the picker shows them. */
export const QUICK_FIELDS = Object.freeze([
  { value: 'form', label: 'Form' },
  { value: 'lemma', label: 'Lemma' },
  { value: 'upos', label: 'UPOS' },
  { value: 'xpos', label: 'XPOS' },
  { value: 'deprel', label: 'Dependency relation' },
  { value: 'feats', label: 'Features' },
]);

export const MATCH_TYPES = Object.freeze([
  { value: 'contains', label: 'contains' },
  { value: 'exact', label: 'is' },
  { value: 'regex', label: 'matches' },
]);

// Grew string literals are double-quoted; a regex literal is re"…". Both need
// the quote and the backslash escaped, and nothing else — the pattern text is
// parsed by our own lexer, not by a shell.
const quote = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// What a `contains` search means as a regex: the text, with every regex
// metacharacter made literal. Someone typing `dog.` wants a full stop.
const literalRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The Grew pattern for one quick search, or null when there is nothing to
 * search for. `field` is one of QUICK_FIELDS, `match` one of MATCH_TYPES.
 */
export function quickPattern(field, match, text) {
  const needle = String(text ?? '').trim();
  if (!needle) return null;

  const value =
    match === 'exact'
      ? quote(needle)
      : `re${quote(match === 'regex' ? needle : literalRegex(needle))}`;

  if (field === 'deprel') {
    // A relation is between two words, and the one being looked for is the
    // dependent: "show me the nsubj relations" means show me their dependents,
    // which is the word a reader wants to land on.
    //
    // The label goes in the ARC, never as `e.label` on a named edge: the
    // compiler reads `e.something` as a feature of a NODE called e, so
    // `e.label = re"subj"` compiles to a search for a FEATS span reading
    // `label=subj` on a word — no error, no warning, no matches.
    return match === 'exact' ? `pattern { H -[${needle}]-> W }` : `pattern { H -[${value}]-> W }`;
  }

  if (field === 'feats') {
    // A feature span stores the whole `Key=Value`, so a plain search over FEATS
    // is a search over that string. `Number=Sing` and `Number` both work.
    return `pattern { W [FEATS=${value}] }`;
  }

  return `pattern { W [${field}=${value}] }`;
}
