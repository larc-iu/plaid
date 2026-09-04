// The zero morph: a morpheme with grammatical content and no surface material.
//
// It is stored as a literal ∅ (U+2205 EMPTY SET) in a morpheme's
// `metadata.form`, which needs no model change at all: an IGT morpheme already
// carries its own form and shares its word's extent (see
// mutations/morphemes.js), so there is nothing for a zero to be empty of.
//
// WHY A LITERAL CHARACTER AND NOT AN EMPTY FORM. `form: ''` is already spoken
// for. A split writes it the instant the caret sits at a form's right edge, and
// the grid gives it a meaning the user acts on: Backspace on an emptied
// morpheme deletes that morpheme. A deliberate zero cannot share that state
// without every consumer having to guess which of the two it is looking at.
//
// This also happens to be exactly what FieldWorks does. A FLEx database stores
// the literal ∅ in a WfiMorphBundle's form and in a lexicon allomorph's form,
// with an ordinary morph type (a zero suffix is a suffix whose form is ∅), and
// there is no null morph type in its inventory. So the character round-trips
// through .flextext and LIFT with no special handling on either side.
//
// NOT Ø or ø (U+00D8 / U+00F8). Those are letters of the Danish and Norwegian
// alphabets and a code produces them on purpose (`\O/`, `\o/`). Never fold one
// into the other; the Validation tab flags a form that looks like a
// mistyped zero instead.

/** The zero morph, spelled the way FLEx spells it. */
export const ZERO_MORPH = '∅';

/** Is this form a zero morph? */
export const isZeroMorph = (form) => form === ZERO_MORPH;

/**
 * Characters people reach for when they mean ∅. Used by validation to offer a
 * correction, never to rewrite anything automatically: `0` is a real form in a
 * text about numbers, and Ø is a real letter.
 */
export const ZERO_MORPH_LOOKALIKES = Object.freeze(['Ø', 'ø', '0', '*0', '^0']);

/** Does this form look like a zero someone spelled the wrong way? */
export const looksLikeZeroMorph = (form) => ZERO_MORPH_LOOKALIKES.includes(form);
