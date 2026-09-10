import {
  EMPTY_LANGUAGE,
  IGT_NAMESPACE,
  hasLanguageIdentity,
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
// project that already names a language keeps it: this is a first record,
// never a correction.
const ISO_639_3 = /^[a-z]{3}$/;
const language = (tag) => ({
  ...EMPTY_LANGUAGE,
  ...(tag ? { tag, ...(ISO_639_3.test(tag) ? { iso639P3: tag } : {}) } : {}),
});

export async function recordProjectLanguages(client, project, { object, meta }) {
  const current = readLanguages(project.config);
  if (hasLanguageIdentity(current.object) || hasLanguageIdentity(current.meta)) return false;
  if (!object && !meta) return false;
  await client.projects.setConfig(project.id, IGT_NAMESPACE, 'languages', {
    object: language(object),
    meta: language(meta),
  });
  return true;
}
