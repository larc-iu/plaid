// Field names that carry a writing system in their name.
//
// The FLEx importer names a field for the primary analysis writing system with
// the bare name and suffixes every other one ("Gloss", "Gloss (nl)"; see
// fieldName() in import/flex/importEngine.js). Nothing else records what
// language a field's values are in, so both FLEx exporters read the suffix back
// out of the name here.

/**
 * Split a field name into its base and writing system: "gloss (ru)" →
 * { base: 'gloss', ws: 'ru' }, "gloss" → { base: 'gloss', ws: null }. The lazy
 * base makes the LAST parenthesized group the writing system, so a field
 * genuinely named "Note (old)" keeps "Note" as its base, which is what the
 * importer meant by it in the first place.
 */
export function parseFieldName(name) {
  const m = /^(.*?)(?: \(([^()]+)\))?$/.exec(String(name ?? ''));
  return { base: m?.[1] ?? '', ws: m?.[2] ?? null };
}

// A BCP 47-shaped tag: two or three letters, then subtags. Loose on purpose —
// it only has to separate a writing system from the other things people put in
// parentheses ("Translation (free)", "Gloss (broad)").
const LANG_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Whether a string is shaped like a language tag on its own ("nl", "oni"). */
export const isLangTag = (s) => LANG_TAG.test(String(s ?? ''));

/**
 * The writing system a field name declares, or null. Unlike parseFieldName this
 * one judges the suffix: only a language-tag-shaped one counts, because a wrong
 * tag here becomes a wrong `lang` on the way out.
 */
export const fieldNameLang = (name) => {
  const { ws } = parseFieldName(name);
  return ws && isLangTag(ws) ? ws : null;
};
