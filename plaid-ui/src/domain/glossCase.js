// The case rule that tells a grammatical gloss from a lexical one, and the
// small caps print sets tags in, shared because every app that shows an
// interlinear gloss reads it the same way: plaid-igt's tagsets, its Analyze
// tab and LaTeX export, and plaid-umr's word rows. plaid-igt's
// domain/tagsets.js re-exports all of it, with the per-cell readings that
// need its morph types (morphemeGlossReading, glossReadingOf).

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * Does this part read as a LEXICAL gloss rather than a grammatical one?
 *
 * The Leipzig rules write grammatical glosses in capitals and digits (NOM, 1SG,
 * PST) and lexical glosses as ordinary words (dog, run). What marks a tag is
 * that it is written in capitals, so a part is lexical when it has a lowercase
 * letter, or when it has letters but no capital at all. The second clause is
 * what makes this work for a metalanguage without case: a Hindi or Japanese
 * stem gloss (कुत्ता, 犬) cannot be written in capitals, so it cannot be
 * carrying the mark, while NOM and 1SG beside it still are. A person and
 * number is a tag in either case (3sg is never a word).
 *
 * It is deliberately not clever. `I` for a first-person pronoun is a capital
 * and counts as grammatical, which means listing it in the tagset, exactly
 * what a tagset is for. A bare digit (3) has no letters and is a tag too.
 *
 * Read with the rest of its value (lexicalFlags), one exception applies: a
 * glossing tradition may write its abbreviations in lower case inside a
 * compound gloss (Lamkang sbj:3.pfv). Where a part of a morpheme's gloss is a
 * tag by the case rule, a known abbreviation of two letters or more beside it
 * in the same morpheme is a tag too. When that leaves a unit with no lexical
 * part where the case rule found one, the case rule stands: pass.PST is the
 * verb pass. The unit is the glosses that could name one word on one line,
 * its stems' (or the word's own gloss, read alone). An affix's, a clitic's
 * or a zero morph's gloss is read by the lenient reading with no fall-back,
 * so a suffix glossed sbj:3.pfv is all tags. A value read with no morph type
 * beside it (a word's cell, a sentence's, a document's) is a stem's or a word's.
 * A value known only by its own morph type (an aggregate count, a lexicon
 * entry) is read by glossReadingOf.
 * The UMR skeleton reads glosses by the same rule
 * (plaid_client.workflows.igt.glossing, with a mirror test).
 */
const LOWERCASE_RE = /\p{Ll}/u;
const CAPITAL_RE = /[\p{Lu}\p{Lt}]/u;
const LETTER_RE = /\p{L}/u;
const MARK_RE = /[\p{L}\p{N}]/u;
const PERSON_NUMBER_RE = /^[1-4](SG|PL|DU|TRI|PAUC|NSG)$/i;

/**
 * The abbreviations the lenient reading knows, upper case: the Leipzig
 * Glossing Rules list, with Lamkang's POS beside POSS.
 */
export const GLOSS_ABBREVIATIONS = Object.freeze(
  new Set(
    `1 2 3 4 A ABL ABS ACC ADJ ADV AGR ALL ANTIP APPL ART AUX BEN CAUS CLF COM COMP
    COMPL COND COP CVB DAT DECL DEF DEM DET DIST DISTR DU DUR ERG EXCL F FOC FUT GEN
    HAB IMP INCL IND INDF INF INS INTR IPFV IRR LOC M N NEG NMLZ NOM NPST NSG OBJ OBL
    P PASS PAUC PFV PL POS POSS PRED PRF PROG PROH PROX PRS PST PTCP PURP Q QUOT
    REAL RECP REFL REL RES S SBJ SBJV SG TOP TR TRI VOC`.split(/\s+/),
  ),
);

const isCaseLexical = (part, known) => {
  if (PERSON_NUMBER_RE.test(part) || known.has(part)) return false;
  return LOWERCASE_RE.test(part) || (LETTER_RE.test(part) && !CAPITAL_RE.test(part));
};

const strictFlags = (morphemes, known) =>
  morphemes.map((parts) => parts.map((p) => isCaseLexical(p, known)));

const lenientOf = (morphemes, strict, known) =>
  morphemes.map((parts, i) => {
    const flags = strict[i];
    const mixed = parts.length > 1 && parts.some((p, j) => !flags[j] && MARK_RE.test(p));
    return parts.map(
      (p, j) => flags[j] && !(mixed && [...p].length > 1 && known.has(p.toUpperCase())),
    );
  });

const anyFlag = (fs) => fs.some((f) => f.some(Boolean));

/**
 * Which parts of one unit are lexical, morpheme by morpheme: `morphemes` is
 * an array of morphemes, each an array of part strings. The case rule, the
 * lenient reading within each morpheme and the fall-back over the whole.
 */
export const lexicalFlags = (morphemes, known = GLOSS_ABBREVIATIONS) => {
  const strict = strictFlags(morphemes, known);
  const lenient = lenientOf(morphemes, strict, known);
  return anyFlag(strict) && !anyFlag(lenient) ? strict : lenient;
};

/**
 * lexicalFlags without the fall-back, for a gloss that can never name its
 * word (an affix's, a clitic's, a zero morph's): sbj:3.pfv stays all tags.
 */
export const lenientFlags = (morphemes, known = GLOSS_ABBREVIATIONS) =>
  lenientOf(morphemes, strictFlags(morphemes, known), known);

/** One part read on its own. */
export const isLexicalPart = (part) => lexicalFlags([[str(part)]])[0][0];

/** What a gloss is cut into morphemes on, and a morpheme into parts on. */
const MORPHEME_CUT_RE = /[-=~<>\s]+/u;
const PART_CUT_RE = /[.:;\\]+/u;

/** A gloss value as morphemes, each an array of its parts, empties left out. */
export const glossMorphemes = (value) =>
  str(value)
    .split(MORPHEME_CUT_RE)
    .map((m) => m.split(PART_CUT_RE).filter(Boolean))
    .filter((parts) => parts.length > 0);

/**
 * Which of `parts` (each { text, begin, end }, cut out of `value` in any way:
 * a tagset's delimiters, the letters of a LaTeX line) read as lexical.
 * lexicalFlags reads the value as glossMorphemes cuts it, and a part is
 * lexical when its own text is lexical by the case rule and it overlaps a
 * part of that reading that stayed lexical. So the pfv of go-3SG.pfv is a
 * tag under a tagset that splits on "." alone, and the PL of go+PL is one
 * under a tagset that splits on "+".
 *
 * `bound` says which of the value's gloss parts belong to a gloss that can
 * never name its word, read with no fall-back: true or false for the whole
 * value, or a function of a gloss part's position among the value's parts
 * (boundByPieces). `beside` is the other glosses in the unit of the value's
 * stems, which count toward the fall-back and are not flagged themselves.
 * With neither, the value is one stem's or one word's gloss.
 */
const GLOSS_PART_RE = /[^.:;\\\-=~<>\s]+/gu;
export const lexicalFlagsOf = (value, parts, { bound = false, beside = [] } = {}) => {
  const s = str(value);
  const boundAt = typeof bound === 'function' ? bound : () => !!bound;
  const cut = [...s.matchAll(GLOSS_PART_RE)];
  const morphemes = [];
  const bounds = [];
  const at = [];
  let current = [];
  let end = null;
  cut.forEach((m, k) => {
    if (end !== null && MORPHEME_CUT_RE.test(s.slice(end, m.index))) {
      morphemes.push(current);
      current = [];
    }
    if (!current.length) bounds.push(boundAt(k));
    at[k] = [morphemes.length, current.length];
    current.push(m[0]);
    end = m.index + m[0].length;
  });
  if (current.length) morphemes.push(current);
  const namers = morphemes.filter((_, i) => !bounds[i]);
  const unit = lexicalFlags([...namers, ...beside.flatMap(glossMorphemes)]);
  const lenient = lenientFlags(morphemes.filter((_, i) => bounds[i]));
  let n = 0;
  let b = 0;
  const flags = morphemes.map((_, i) => (bounds[i] ? lenient[b++] : unit[n++]));
  return parts.map((p) => {
    const text = str(p.text).trim();
    if (!text || !isCaseLexical(text, GLOSS_ABBREVIATIONS)) return false;
    return cut.some(
      (m, k) => m.index < p.end && p.begin < m.index + m[0].length && flags[at[k][0]][at[k][1]],
    );
  });
};

/**
 * The `bound` of lexicalFlagsOf for a value joined from a word's morpheme
 * glosses: `pieces` is [{ text, bound }] in order, each piece one morpheme's
 * gloss, and the joints between them are separators. A position past the
 * last piece is not bound.
 */
export const boundByPieces = (pieces) => {
  const flags = (pieces || []).flatMap((p) =>
    [...str(p.text).matchAll(GLOSS_PART_RE)].map(() => !!p.bound),
  );
  return (k) => flags[k] ?? false;
};

/**
 * A gloss as print sets it: each grammatical abbreviation in small caps, so
 * "1SG.NOM" is two small-caps parts. The parts are runs of letters, marks
 * and digits (whatever lies between is kept as it is), and a part is set in
 * small caps when it holds a letter and lexicalFlagsOf does not read it as
 * lexical. `reading` is lexicalFlagsOf's options for the value: a morpheme
 * cell's reading (morphemeGlossReading), `{ bound: boundByPieces(pieces) }`
 * for a word's joined morpheme glosses, or nothing for a word's own gloss.
 * The LaTeX export and the Analyze tab both set glosses by it.
 */
const SMALL_CAPS_PART_RE = /[\p{L}\p{M}\p{N}]+/gu;
const HAS_LETTER_RE = /\p{L}/u;
export const glossSmallCaps = (value, reading = undefined) => {
  const s = str(value);
  const matches = [...s.matchAll(SMALL_CAPS_PART_RE)];
  const lexical = lexicalFlagsOf(
    s,
    matches.map((m) => ({ text: m[0], begin: m.index, end: m.index + m[0].length })),
    reading,
  );
  const out = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.index > at) out.push({ text: s.slice(at, m.index), smallCaps: false });
    out.push({ text: m[0], smallCaps: HAS_LETTER_RE.test(m[0]) && !lexical[i] });
    at = m.index + m[0].length;
  });
  if (at < s.length) out.push({ text: s.slice(at), smallCaps: false });
  return out;
};

/**
 * Whether a gloss cell can show its value with every capital drawn as a small
 * capital (the font's c2sc), and so read as glossSmallCaps sets it: it holds
 * a capital, and every part with one is a small-caps part. A lowercase tag
 * stays as typed, and a value with a capitalised word in it (John-PL) shows
 * as typed too, since c2sc would shrink the J with the PL.
 */
const UPPER_RE = /\p{Lu}/u;
export const capsAreSmallCaps = (value, reading = undefined) => {
  const upper = glossSmallCaps(value, reading).filter((p) => UPPER_RE.test(p.text));
  return upper.length > 0 && upper.every((p) => p.smallCaps);
};
