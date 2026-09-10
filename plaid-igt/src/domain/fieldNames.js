// Field names that carry a writing system in their name.
//
// The FLEx importer names a field for the primary analysis writing system with
// the bare name and suffixes every other one ("Gloss", "Gloss (nl)"; see
// fieldName() in import/flex/importEngine.js). That is a NAMING convention:
// what language a field's values are in is recorded on the field itself
// (config.igt.lang), written by every importer, shown and edited in the Fields
// settings, and back-filled from the suffix once for a project made before
// the record existed (igtReconcile.planFieldLangBackfill). The exporters read
// the record and never the name, so renaming a field cannot change the
// language its values go out under. The suffix is read here only to PROPOSE a
// language: when a field is made or back-filled.

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

/**
 * The writing system a field's values go out under, most trustworthy first:
 * an explicit override from the export preset, then what the FIELD ITSELF
 * records (config.igt.lang), then the preset's one tag for glosses and
 * translations. Never the field's name: see the note at the top.
 *
 * The FLEx exporter and the screen that configures it both resolve through
 * here, so the tag shown beside a field is the tag it goes out under. They
 * disagreed once, and a preview that lies about the export is worse than no
 * preview: FLEx keeps one value per writing system, so two fields landing on
 * the same tag lose one of them without a word.
 *
 * @param {{overrides?: object, fieldLangs?: object, analysis?: string}} langs
 * @param {'Sentence'|'Word'|'Morpheme'} scope
 */
export const resolveFieldLang = (langs, scope, field) =>
  langs?.overrides?.[field] || langs?.fieldLangs?.[`${scope}:${field}`] || langs?.analysis || '';

// A field's identity on a layer: the same name can exist at two scopes (a
// FieldWorks import gives "Gloss" and "POS" at both Word and Morpheme scope),
// so nothing may key on the name alone.
export const fieldKey = (f) => `${f.scope}:${f.name}`;
