// One-line definitions for the universal tag sets, shown beside a value in the
// picker and in the inventory editor.
//
// These are glosses of the definitions at universaldependencies.org, written
// for an annotator mid-decision rather than copied: what a tag is FOR, and
// where the confusable neighbour sits. A project that edits its vocabulary
// edits these too (they seed `ud.vocabDescriptions`), so nothing here is
// binding: it is the starting point a fresh project gets.
//
// Each is a message, shown in the reader's language: `shippedDescriptions`
// gives the maps translated, for the picker and for telling an edited
// description from the one that ships (udVocab.js `vocabCells`), so a
// description nobody edited is never stored, in any language.

// By its real path: the `node --test` suite has no `@ui` alias.
import { msg, t } from '../../../plaid-ui/src/lib/i18n.js';

/** The 17 universal parts of speech. */
export const UPOS_DESCRIPTIONS = Object.freeze({
  ADJ: msg('Adjective. Modifies a noun. Ordinal numbers are ADJ, cardinals are NUM.'),
  ADP: msg('Adposition. A preposition or postposition governing a noun phrase.'),
  ADV: msg('Adverb. Modifies a verb, adjective or another adverb.'),
  AUX: msg('Auxiliary. A function verb carrying tense, mood, aspect, voice or negation.'),
  CCONJ: msg('Coordinating conjunction. Links equals, such as and or but.'),
  DET: msg('Determiner. Specifies a noun phrase: articles, demonstratives, possessives.'),
  INTJ: msg('Interjection. An exclamation or filler, standing outside the clause.'),
  NOUN: msg('Common noun. A person, place or thing that is not a name.'),
  NUM: msg('Numeral. A cardinal number, as a word or as digits.'),
  PART: msg('Particle. A function word that is none of the other function classes.'),
  PRON: msg('Pronoun. Stands in for a noun phrase.'),
  PROPN: msg('Proper noun. The name of a specific entity.'),
  PUNCT: msg('Punctuation. A non-alphabetic mark.'),
  SCONJ: msg('Subordinating conjunction. Introduces a dependent clause.'),
  SYM: msg('Symbol. A non-alphabetic sign that is not punctuation, such as % or an emoji.'),
  VERB: msg('Verb. The lexical head of a clause. A function verb is AUX.'),
  X: msg('Other. The word cannot be assigned a part of speech.'),
});

/** The 37 universal dependency relations and the enhanced relation ref. */
export const DEPREL_DESCRIPTIONS = Object.freeze({
  acl: msg('Clause modifying a noun, such as a relative clause.'),
  advcl: msg('Clause modifying a verb, adjective or other predicate.'),
  advmod: msg('Adverbial modifier of a predicate or modifier.'),
  amod: msg('Adjective modifying a noun.'),
  appos: msg('Apposition. A second noun phrase renaming the first.'),
  aux: msg('Auxiliary verb attached to its main verb.'),
  case: msg('Adposition or case marker attached to the noun it marks.'),
  cc: msg('Coordinating conjunction, attached to the conjunct that follows it.'),
  ccomp: msg('Clausal complement with its own subject.'),
  clf: msg('Classifier accompanying a numeral.'),
  compound: msg('Word forming a compound with its head noun or verb.'),
  conj: msg('Conjunct. A second or later element of a coordination, attached to the first.'),
  cop: msg('Copula linking a subject to a non-verbal predicate.'),
  csubj: msg('Clause acting as the subject.'),
  dep: msg('Unspecified. Use when no other relation fits, not as a default.'),
  det: msg('Determiner attached to its noun.'),
  discourse: msg('Interjection or discourse marker, outside the clause proper.'),
  dislocated: msg('Noun phrase outside the core structure, such as a fronted topic.'),
  expl: msg('Expletive. A subject or object filling a slot without a role, like "it rains".'),
  fixed: msg('Part of a fixed multi-word function expression, such as "as well as".'),
  flat: msg('Part of a headless sequence of equals, such as a first and last name.'),
  goeswith: msg('A word wrongly split in the text, attached to its first part.'),
  iobj: msg('Indirect object. A core argument that is not the direct object.'),
  list: msg('Item in a list of comparable entries, attached to the first.'),
  mark: msg('Subordinating conjunction or infinitive marker, attached to its clause.'),
  nmod: msg('Noun phrase modifying another noun.'),
  nsubj: msg('Nominal subject.'),
  nummod: msg('Numeral modifying a noun.'),
  obj: msg('Direct object. The most affected core argument after the subject.'),
  obl: msg('Oblique. A noun phrase modifying a predicate without being a core argument.'),
  orphan: msg('Promoted dependent of an elided head, in a gapped coordination.'),
  parataxis: msg('Clause juxtaposed without a conjunction or subordination.'),
  punct: msg('Punctuation, attached to the head of the phrase it belongs with.'),
  ref: msg('Referent. Enhanced graph only: attaches a relative pronoun to the noun it stands for.'),
  reparandum: msg('Disfluency the speaker replaced, attached to what replaced it.'),
  root: msg('Head of the sentence. Exactly one per sentence.'),
  vocative: msg('Addressee named in the sentence.'),
  xcomp: msg('Clausal complement whose subject is supplied by the main clause.'),
});

const translated = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, t(v)]));

/** The descriptions that ship, in the reader's language: `{ upos, deprel }`. */
export const shippedDescriptions = () => ({
  upos: translated(UPOS_DESCRIPTIONS),
  deprel: translated(DEPREL_DESCRIPTIONS),
});
