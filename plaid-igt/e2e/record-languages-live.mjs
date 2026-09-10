// One-off for a project imported from FLEx before 2026-09-10: record what the
// importer now records on its own. (1) The primary analysis writing system on
// the lexicon's bare gloss and definition fields, so LIFT exports label them.
// (2) The project's two languages, so the FLEx export offers the right codes
// instead of und/en. A field or language already set is left alone.
// Run from plaid-igt/:
//   PLAID_URL=https://plaid.langdoc.net PLAID_TOKEN=<admin token> \
//     node e2e/record-languages-live.mjs <projectId> pmy oni
import PlaidClient from '@larc-iu/plaid-client';
const [projectId, analysisTag, vernacularTag] = process.argv.slice(2);
if (!projectId || !analysisTag)
  throw new Error('usage: <projectId> <analysis tag> [<vernacular tag>]');
const client = new PlaidClient(process.env.PLAID_URL, process.env.PLAID_TOKEN);
const project = await client.projects.get(projectId);

// The lexicon's gloss and definition language.
for (const v of project.vocabs || []) {
  const vocab = await client.vocabLayers.get(v.id);
  const fields = { ...(vocab.config?.igt?.fields ?? {}) };
  let changed = false;
  for (const k of ['gloss', 'definition']) {
    if (fields[k] && !fields[k].lang) {
      fields[k] = { ...fields[k], lang: analysisTag };
      changed = true;
    }
  }
  if (changed) await client.vocabLayers.setConfig(v.id, 'igt', 'fields', fields);
  console.log(
    'lexicon',
    vocab.name,
    changed ? `glosses labelled ${analysisTag}` : 'already labelled',
  );
}

// The project's languages, in the shape src/import/projectLanguages.js writes.
const ISO_639_3 = /^[a-z]{3}$/;
const language = (tag) => ({
  name: '',
  glottocode: '',
  iso639P3: ISO_639_3.test(tag) ? tag : '',
  latitude: null,
  longitude: null,
  tag,
});
const current = project.config?.igt?.languages;
const has = (l) => l && (l.name || l.glottocode || l.iso639P3 || l.tag);
if (has(current?.object) || has(current?.meta)) {
  console.log('project languages already set:', JSON.stringify(current));
} else if (vernacularTag) {
  await client.projects.setConfig(projectId, 'igt', 'languages', {
    object: language(vernacularTag),
    meta: language(analysisTag),
  });
  console.log(`project languages recorded: ${vernacularTag} (text), ${analysisTag} (analysis)`);
} else {
  console.log('project languages not set (no vernacular tag given)');
}
