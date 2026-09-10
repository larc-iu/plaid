import { IGT_NAMESPACE, hasLanguageIdentity, readLanguages } from '../domain/igtConfig.js';

// The project's two languages, recorded by an importer that read them off its
// source: the vernacular writing system is the language documented, the
// primary analysis one is what glosses and translations are in. The FLEx
// export reads its defaults from here, and without them offered `und` for
// the baseline and `en` for analysis until the user typed the codes in (the
// first real user did, and asked why Plaid could not see for itself that the
// unmarked fields were Papuan Malay). The tag goes in as the code verbatim,
// since that tag is what FLEx wants back. A project that already names a
// language keeps it: this is a first record, never a correction.
export async function recordProjectLanguages(client, project, { object, meta }) {
  const current = readLanguages(project.config);
  if (hasLanguageIdentity(current.object) || hasLanguageIdentity(current.meta)) return false;
  if (!object && !meta) return false;
  const empty = { name: '', glottocode: '', iso639P3: '', latitude: null, longitude: null };
  await client.projects.setConfig(project.id, IGT_NAMESPACE, 'languages', {
    object: { ...empty, ...(object ? { iso639P3: object } : {}) },
    meta: { ...empty, ...(meta ? { iso639P3: meta } : {}) },
  });
  return true;
}
