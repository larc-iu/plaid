/**
 * How a lexicon entry's form is stored: without affix or clitic markers. An
 * entry's marker is drawn from its morph type ("-s" is a suffix "s", "ni=" a
 * proclitic "ni"), so every writer of an entry form, in every app and in the
 * Python client (plaid_client.workflows.igt.entry_forms), passes the form and
 * type it was given through `entryForm` and stores what comes back.
 *
 * The morph types are FieldWorks' MoMorphType inventory, which LIFT and
 * .flextext need verbatim. The markers are each type's Prefix and Postfix as
 * FieldWorks spells a morph standing alone, read off the factory objects of
 * real .fwbackup files (identical in Lezgi, Sena, Arabic, Onim and Lamkang).
 * The seven types left out of the table (stem, root, circumfix, clitic,
 * particle, phrase, discontiguous phrase) have no marker in that data.
 */

/** FieldWorks' morph types, the values a stored morph type may take. */
export const MORPH_TYPES = Object.freeze([
  "stem",
  "bound stem",
  "root",
  "bound root",
  "prefix",
  "suffix",
  "infix",
  "circumfix",
  "simulfix",
  "suprafix",
  "infixing interfix",
  "prefixing interfix",
  "suffixing interfix",
  "clitic",
  "enclitic",
  "proclitic",
  "particle",
  "phrase",
  "discontiguous phrase",
]);

/** @type {Readonly<Record<string, readonly [string, string]>>} */
const MORPH_TYPE_MARKERS = Object.freeze({
  "bound root": ["*", ""],
  "bound stem": ["*", ""],
  enclitic: ["=", ""],
  infix: ["-", "-"],
  "infixing interfix": ["-", "-"],
  prefix: ["", "-"],
  "prefixing interfix": ["", "-"],
  proclitic: ["", "="],
  simulfix: ["=", "="],
  suffix: ["-", ""],
  "suffixing interfix": ["-", ""],
  suprafix: ["~", "~"],
});

// The one plain type each pair of "-" and "=" markers names, keyed
// "<before>,<after>". The interfixes share their markers with a plainer type,
// so markers alone never name one, and "*" and "~" are left out because both
// also occur in forms as themselves (a reconstructed "*kwa").
/** @type {Readonly<Record<string, string>>} */
const TYPE_BY_MARKERS = Object.freeze({
  "-,": "suffix",
  ",-": "prefix",
  "-,-": "infix",
  "=,": "enclitic",
  ",=": "proclitic",
  "=,=": "simulfix",
});

/**
 * A form written the way FieldWorks writes a morph standing alone: "-ar" for
 * a suffix, "ka-" for a prefix, "=ni" for an enclitic, unchanged for a stem or
 * for a type outside the table or none.
 *
 * @template {string | null | undefined} F
 * @param {string | null | undefined} morphType
 * @param {F} form
 * @returns {F | string}
 */
export function decorateWithAffixMarkers(morphType, form) {
  if (form == null || form === "") return form;
  const marks = MORPH_TYPE_MARKERS[String(morphType ?? "").toLowerCase()];
  return marks ? `${marks[0]}${form}${marks[1]}` : form;
}

/** @param {string} form @param {string} type */
const strips = (form, type) => {
  const [before, after] = MORPH_TYPE_MARKERS[type] ?? ["", ""];
  return before + after !== "" &&
    form.length > before.length + after.length &&
    form.startsWith(before) &&
    form.endsWith(after)
    ? form.slice(before.length, form.length - after.length)
    : null;
};

/** @param {string} form */
const markedType = (form) => {
  const m = /^([-=]?)(.+?)([-=]?)$/su.exec(form);
  const type = m && TYPE_BY_MARKERS[`${m[1]},${m[3]}`];
  return type && m ? { form: m[2], morphType: type } : null;
};

/**
 * A morph form as FieldWorks writes it, read back: the inverse of
 * decorateWithAffixMarkers. A morph of a known type loses exactly that type's
 * markers ("-ar" of a suffix is "ar"), and a form without them is kept as
 * written. A morph with no type, or a type outside MORPH_TYPES, takes the type
 * its markers name ("ni=" is a proclitic), and keeps its form whole when they
 * name none. The type comes back lower-cased, or null.
 *
 * @param {string | null | undefined} morphType
 * @param {string | null | undefined} form
 * @returns {{ form: string | null | undefined, morphType: string | null }}
 */
export function readAffixMarkers(morphType, form) {
  const named = String(morphType ?? "").toLowerCase();
  const known = MORPH_TYPES.includes(named) ? named : null;
  if (form == null || form === "") return { form, morphType: known };
  if (known) return { form: strips(form, known) ?? form, morphType: known };
  return markedType(form) ?? { form, morphType: null };
}

/**
 * The form and morph type an entry stores, from the form and type a person,
 * a file or a model gave. A form carrying its type's markers loses them
 * ("-s" of a suffix is "s"). A form carrying "-" or "=" markers that name a
 * type loses them and takes that type, whatever type came with it: "-s"
 * given as a stem, or with no type, is the suffix "s". Any other form is kept
 * as written with the type it came with, which is returned as given ("*kwa"
 * with no type stays "*kwa", a reconstructed form).
 *
 * @template {string | null | undefined} T
 * @param {T} morphType
 * @param {string | null | undefined} form
 * @returns {{ form: string | null | undefined, morphType: T | string }}
 */
export function entryForm(morphType, form) {
  if (typeof form !== "string" || form === "") return { form, morphType };
  const own = typeof morphType === "string" ? morphType.toLowerCase() : "";
  const bare = MORPH_TYPES.includes(own) ? strips(form, own) : null;
  if (bare != null) return { form: bare, morphType };
  return markedType(form) ?? { form, morphType };
}
