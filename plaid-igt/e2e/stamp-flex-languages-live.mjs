// One-off for a project imported from FLEx before 2026-09-10 (2bbf9ac8): record what the
// import now records itself. Lives here so the client resolves:
//   PLAID_URL=https://plaid.langdoc.net PLAID_TOKEN=<admin token> \
//     node e2e/stamp-flex-languages-live.mjs <projectId> <vernacular> <analysis> [posLang]
//   e.g. ... <projectId> oni pmy en
// Writes, and only where nothing is recorded yet:
//   - config.igt.languages on the project (object = vernacular, meta = analysis)
//   - config.igt.lang on every annotation field: "Name (xx)" -> xx, POS -> posLang
//     (default en, the language FLEx categories are named in), anything else -> analysis
//   - config.igt.fields.gloss/definition.lang on every vocabulary -> analysis
import PlaidClient from '@larc-iu/plaid-client';
const [projectId, vernacular, analysis, posLang = 'en'] = process.argv.slice(2);
if (!projectId || !vernacular || !analysis)
  throw new Error('usage: <projectId> <vernacular> <analysis> [posLang]');
const client = new PlaidClient(process.env.PLAID_URL, process.env.PLAID_TOKEN);
const project = await client.projects.get(projectId);

const langs = project.config?.igt?.languages;
const named = (l) => !!(l?.name || l?.glottocode || l?.iso639P3);
if (!named(langs?.object) && !named(langs?.meta)) {
  const empty = { name: '', glottocode: '', iso639P3: '', latitude: null, longitude: null };
  await client.projects.setConfig(projectId, 'igt', 'languages', {
    object: { ...empty, iso639P3: vernacular },
    meta: { ...empty, iso639P3: analysis },
  });
  console.log(`project languages: ${vernacular} / ${analysis}`);
} else console.log('project languages: already named');

for (const tl of project.textLayers || [])
  for (const l of tl.tokenLayers || [])
    for (const sl of l.spanLayers || []) {
      if (!sl.config?.igt?.scope) continue;
      if (sl.config?.igt?.lang) {
        console.log(`  ${sl.name}: already ${sl.config.igt.lang}`);
        continue;
      }
      const m = /\(([A-Za-z][\w-]*)\)\s*$/.exec(sl.name);
      const lang = m ? m[1] : /^pos$/i.test(sl.name.trim()) ? posLang : analysis;
      await client.spanLayers.setConfig(sl.id, 'igt', 'lang', lang);
      console.log(`  ${sl.name} (${sl.config.igt.scope}): ${lang}`);
    }

for (const v of project.vocabs || []) {
  const vocab = await client.vocabLayers.get(v.id);
  const fields = { ...(vocab.config?.igt?.fields ?? {}) };
  let changed = false;
  for (const k of ['gloss', 'definition']) {
    if (fields[k] && !fields[k].lang) {
      fields[k] = { ...fields[k], lang: analysis };
      changed = true;
    }
  }
  if (changed) await client.vocabLayers.setConfig(v.id, 'igt', 'fields', fields);
  console.log(`vocabulary ${vocab.name}: ${changed ? `glosses ${analysis}` : 'already labelled'}`);
}
