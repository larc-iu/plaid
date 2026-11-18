// Whether `tag` is a BCP-47 language tag (`en`, `en-US`, `zh-Hans`), as the
// browser's Intl reads one. `en_US` is not: Intl.Segmenter throws on it.
export const isLanguageTag = (tag) => {
  if (typeof tag !== 'string' || !tag.trim()) return false;
  try {
    Intl.getCanonicalLocales(tag.trim());
    return true;
  } catch {
    return false;
  }
};
