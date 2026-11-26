// The language of the interface. Every string a person reads on screen goes
// through here.
//
// THE KEY IS THE ENGLISH. A call names its message by the English text itself,
// `t('Save')`, so the code reads as it did, English needs no catalog, and a
// test that looks for "Save" still finds it. A catalog for another language
// maps that English text to its translation (src/locales/<language>/*.json in
// this package and in each app). A message with no translation shows in
// English.
//
// MESSAGES ARE WHOLE SENTENCES in ICU MessageFormat, never joined fragments,
// because another language orders and agrees its words differently:
//
//   t('{n, plural, one {# sentence was} other {# sentences were}} left out.', { n })
//   t('Delete “{name}”?', { name })
//
// Never name a value `count`, `context`, `lng`, `ns`, `defaultValue` or
// `replace`: i18next reads those itself.
//
// THREE WAYS IN:
//   t(message, values)    a string, anywhere: React, the lit-html island, a
//                         pure domain function building a warning.
//   tx(message, values)   React nodes, for a sentence with markup inside it:
//                         tx('Delete <b>{name}</b>?', { name, b: (c) => <b>{c}</b> })
//   tc(sense, message)    a string, for the second meaning of an English
//                         word. See tc below.
//   msg(message)          marks a message in a module-level constant (a table
//                         of labels), which is read before the language is
//                         known. It returns the English, and the place that
//                         shows it calls t() on it.
//
// `t` is never called at module level, for that same reason.
//
// CHANGING LANGUAGE RELOADS THE PAGE. Nothing has to subscribe to the
// language, so t() is a plain function with no hook behind it.

import { Children } from 'react';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { IntlMessageFormat } from 'intl-messageformat';

/** The languages the interface comes in, each named in itself. */
export const LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
]);

const STORE_KEY = 'plaid.language';
const NAMESPACE = 'translation';
const supported = (code) => LANGUAGES.some((l) => l.code === code);

// Ready at import, in English with no catalog, so t() works in a test and in
// a script that never calls initI18n.
i18next.use(ICU).init({
  lng: 'en',
  fallbackLng: false,
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  resources: {},
  // A message that does not parse shows as written rather than throwing.
  i18nFormat: { parseErrorHandler: (_err, key) => key },
});

/** The message in the interface's language, its values filled in. */
export const t = (message, values) => i18next.t(message, values);

/**
 * A message whose English word means two things that another language says
 * two ways: "Comment" the noun and "Comment" the button. The second use
 * names its sense, `tc('verb', 'Comment')`, and a catalog translates it
 * under the key "Comment [verb]". English, and a language with no entry
 * for that key, get the plain message.
 */
export const tc = (sense, message, values) => {
  const key = `${message} [${sense}]`;
  return i18next.getResource(i18next.language, NAMESPACE, key) === undefined
    ? i18next.t(message, values)
    : i18next.t(key, values);
};

/** Marks a message held in a module-level constant. See the note above. */
export const msg = (message) => message;

const formats = new Map();
/**
 * The message as React nodes. A `<tag>` in the message is rendered by the
 * function of that name in `values`, which takes the tag's content.
 */
export const tx = (message, values) => {
  const lng = i18next.language;
  const pattern = i18next.getResource(lng, NAMESPACE, message) ?? message;
  const cacheKey = `${lng}\u0000${pattern}`;
  let format = formats.get(cacheKey);
  if (!format) {
    format = new IntlMessageFormat(pattern, lng);
    formats.set(cacheKey, format);
  }
  const parts = format.format(values);
  return Array.isArray(parts) ? Children.toArray(parts) : parts;
};

/** The language in use, as a BCP 47 code, for Intl formatters. */
export const language = () => i18next.language;

/**
 * Names in a running list, joined as the language joins them: "A", "A and
 * B", "A, B and C" in English, "A, B et C" in French.
 */
export const listOf = (names) => {
  // British English: American English would put a comma before "and".
  const lng = i18next.language === 'en' ? 'en-GB' : i18next.language;
  return new Intl.ListFormat(lng, { type: 'conjunction' }).format(names.map(String));
};

const stored = () => {
  try {
    return globalThis.localStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
};

/**
 * The language to start in: the one this person picked, else the first of
 * the browser's languages that the interface comes in, else English.
 */
export const startingLanguage = () => {
  const picked = stored();
  if (supported(picked)) return picked;
  const wanted = globalThis.navigator?.languages ?? [];
  for (const tag of wanted) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (supported(code)) return code;
  }
  return 'en';
};

/**
 * Load the starting language's catalogs and switch to it. Called once by
 * each app before it renders.
 *
 * @param catalogs  { fr: async () => [catalog, ...] }, each catalog an object
 *   of English message to translation. Later ones win.
 */
export async function initI18n(catalogs = {}) {
  const lng = startingLanguage();
  if (lng !== 'en' && catalogs[lng]) {
    for (const catalog of await catalogs[lng]()) {
      i18next.addResourceBundle(lng, NAMESPACE, catalog, true, true);
    }
  }
  await i18next.changeLanguage(lng);
  if (globalThis.document) globalThis.document.documentElement.lang = lng;
  return lng;
}

/** Pick a language. It is remembered in this browser, and the page reloads. */
export function setLanguage(code) {
  if (!supported(code) || code === i18next.language) return;
  try {
    globalThis.localStorage?.setItem(STORE_KEY, code);
  } catch {
    // Storage is off: the choice lasts until the reload, which is no choice.
  }
  globalThis.location?.reload();
}

// For a test: switch language in place with a catalog, no reload.
async function switchLanguage(code, catalog = {}) {
  if (code !== 'en') i18next.addResourceBundle(code, NAMESPACE, catalog, true, true);
  await i18next.changeLanguage(code);
}

export const __test = { switchLanguage };
