// One-line definitions for the universal tag sets, shown beside a value in the
// picker and in the inventory editor.
//
// These are glosses of the definitions at universaldependencies.org, written
// for an annotator mid-decision rather than copied: what a tag is FOR, and
// where the confusable neighbour sits. A project that edits its vocabulary
// edits these too (they seed `ud.vocabDescriptions`), so nothing here is
// binding: it is the starting point a fresh project gets.

/** The 17 universal parts of speech. */
export const UPOS_DESCRIPTIONS = Object.freeze({
  ADJ: 'Adjective. Modifies a noun. Ordinal numbers are ADJ, cardinals are NUM.',
  ADP: 'Adposition. A preposition or postposition governing a noun phrase.',
  ADV: 'Adverb. Modifies a verb, adjective or another adverb.',
  AUX: 'Auxiliary. A function verb carrying tense, mood, aspect, voice or negation.',
  CCONJ: 'Coordinating conjunction. Links equals, such as and or but.',
  DET: 'Determiner. Specifies a noun phrase: articles, demonstratives, possessives.',
  INTJ: 'Interjection. An exclamation or filler, standing outside the clause.',
  NOUN: 'Common noun. A person, place or thing that is not a name.',
  NUM: 'Numeral. A cardinal number, as a word or as digits.',
  PART: 'Particle. A function word that is none of the other function classes.',
  PRON: 'Pronoun. Stands in for a noun phrase.',
  PROPN: 'Proper noun. The name of a specific entity.',
  PUNCT: 'Punctuation. A non-alphabetic mark.',
  SCONJ: 'Subordinating conjunction. Introduces a dependent clause.',
  SYM: 'Symbol. A non-alphabetic sign that is not punctuation, such as % or an emoji.',
  VERB: 'Verb. The lexical head of a clause. A function verb is AUX.',
  X: 'Other. The word cannot be assigned a part of speech.',
});

/** The 37 universal dependency relations. */
export const DEPREL_DESCRIPTIONS = Object.freeze({
  acl: 'Clause modifying a noun, such as a relative clause.',
  advcl: 'Clause modifying a verb, adjective or other predicate.',
  advmod: 'Adverbial modifier of a predicate or modifier.',
  amod: 'Adjective modifying a noun.',
  appos: 'Apposition. A second noun phrase renaming the first.',
  aux: 'Auxiliary verb attached to its main verb.',
  case: 'Adposition or case marker attached to the noun it marks.',
  cc: 'Coordinating conjunction, attached to the conjunct that follows it.',
  ccomp: 'Clausal complement with its own subject.',
  clf: 'Classifier accompanying a numeral.',
  compound: 'Word forming a compound with its head noun or verb.',
  conj: 'Conjunct. A second or later element of a coordination, attached to the first.',
  cop: 'Copula linking a subject to a non-verbal predicate.',
  csubj: 'Clause acting as the subject.',
  dep: 'Unspecified. Use when no other relation fits, not as a default.',
  det: 'Determiner attached to its noun.',
  discourse: 'Interjection or discourse marker, outside the clause proper.',
  dislocated: 'Noun phrase outside the core structure, such as a fronted topic.',
  expl: 'Expletive. A subject or object filling a slot without a role, like "it rains".',
  fixed: 'Part of a fixed multi-word function expression, such as "as well as".',
  flat: 'Part of a headless sequence of equals, such as a first and last name.',
  goeswith: 'A word wrongly split in the text, attached to its first part.',
  iobj: 'Indirect object. A core argument that is not the direct object.',
  list: 'Item in a list of comparable entries, attached to the first.',
  mark: 'Subordinating conjunction or infinitive marker, attached to its clause.',
  nmod: 'Noun phrase modifying another noun.',
  nsubj: 'Nominal subject.',
  nummod: 'Numeral modifying a noun.',
  obj: 'Direct object. The most affected core argument after the subject.',
  obl: 'Oblique. A noun phrase modifying a predicate without being a core argument.',
  orphan: 'Promoted dependent of an elided head, in a gapped coordination.',
  parataxis: 'Clause juxtaposed without a conjunction or subordination.',
  punct: 'Punctuation, attached to the head of the phrase it belongs with.',
  reparandum: 'Disfluency the speaker replaced, attached to what replaced it.',
  root: 'Head of the sentence. Exactly one per sentence.',
  vocative: 'Addressee named in the sentence.',
  xcomp: 'Clausal complement whose subject is supplied by the main clause.',
});
