import {
  EMPTY_LANGUAGE,
  IGT_NAMESPACE,
  hasLanguageIdentity,
  normalizeLanguage,
  readLanguages,
} from '../domain/igtConfig.js';

// The project's two languages, recorded by an importer that read them off its
// source: the vernacular writing system is the language documented, the
// primary analysis one is what glosses and translations are in. The FLEx
// export reads its defaults from here, and without them offered `und` for
// the baseline and `en` for analysis until the user typed the codes in (the
// first real user did, and asked why Plaid could not see for itself that the
// unmarked fields were Papuan Malay). What a source names is a writing-system
// TAG, recorded as such; it doubles as the ISO 639-3 code only when it is
// shaped like one, since `en` and `qaa-x-abc` are tags and not codes. A
// source that knows more than the tag (CLDF's LanguageTable carries a name, a
// Glottocode and coordinates) passes the record instead, and a code with no
// tag beside it becomes the tag as well, since a 3-letter code is one. A
// project that already names a language keeps it: this is a first record,
// never a correction.
//
// ONE WRITER. Every importer records the languages through here, so the shape
// on the project and the rule about not correcting one have a single home.
const ISO_639_3 = /^[a-z]{3}$/;

const language = (given) => {
  const spec = normalizeLanguage(typeof given === 'string' ? { tag: given } : given);
  const iso = ISO_639_3.test(spec.iso639P3) ? spec.iso639P3 : '';
  const tag = spec.tag || iso;
  return {
    ...EMPTY_LANGUAGE,
    ...spec,
    tag,
    iso639P3: iso || (ISO_639_3.test(tag) ? tag : ''),
  };
};

/**
 * Record what the source said the project's languages are, unless it already
 * says so itself. `object` and `meta` are each a tag or a record.
 *
 * @returns {Promise<boolean>} whether anything was written.
 */
export async function recordProjectLanguages(client, project, { object, meta }) {
  const current = readLanguages(project.config);
  if (hasLanguageIdentity(current.object) || hasLanguageIdentity(current.meta)) return false;
  const next = { object: language(object), meta: language(meta) };
  if (!hasLanguageIdentity(next.object) && !hasLanguageIdentity(next.meta)) return false;
  await client.projects.setConfig(project.id, IGT_NAMESPACE, 'languages', next);
  return true;
}
