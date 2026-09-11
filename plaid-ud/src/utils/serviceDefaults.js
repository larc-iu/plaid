// This app's own half of the service-defaults story. Everything shared with
// plaid-igt lives in `@ui/domain/serviceDefaults`: the selection encoding, the
// project-config reads, and the resolution order a spot starts from.

// The names of this app's built-in implementations, the `<name>` half of a
// `builtin:<name>` selection.
export const BUILTIN_TOKENIZE_SEGMENTER = 'unicode-segmentation';

// The project's language, as a seed for a service argument literally named
// `language` (the parse spot's, today). A service declares its own argument
// list, so the tag is only offered when the service HAS that argument and the
// tag is a value it accepts: a project annotating a language the parser ships
// no model for keeps the service's own default. Returns {} or {language: tag}.
export const languageParamSeed = (schema, language) => {
  const tag = typeof language === 'string' ? language.trim() : '';
  if (!tag) return {};
  const param = (schema || []).find((p) => p?.key === 'language');
  if (!param) return {};
  if (param.type === 'enum' || param.type === 'multiselect') {
    const legal = (param.options || []).some((o) => o?.value === tag);
    if (!legal) return {};
  }
  return { language: tag };
};
