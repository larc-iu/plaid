// One-shot: bring the "E2E IGT Fixture" project's layer config up to the CURRENT
// interop convention the editor actually reads — shared roles at
// `config.plaid.role` + private settings under the `igt` namespace. The fixture
// builder (e2e/fixture.js) predates the 2026-06-06 interop migration and still
// writes the stale `plaid.primary/sentence/morpheme/...` flags, which the editor
// no longer honors (-> "no primary token layer configured"). This patches the
// existing layers in place; the already-seeded tokens/spans are unaffected.
import PlaidClient from '@larc-iu/plaid-client';
import { ROLES } from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';

const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const PROJECT_NAME = 'E2E IGT Fixture';

const client = new PlaidClient(CORE_URL, readToken().token);

const project = (await client.projects.list()).find((p) => p.name === PROJECT_NAME);
if (!project) throw new Error(`Project "${PROJECT_NAME}" not found`);
const full = await client.projects.get(project.id);

const textLayer = (full.textLayers || []).find((l) => l.config?.plaid?.primary) || (full.textLayers || [])[0];
const tokenLayers = textLayer?.tokenLayers || [];
const byFlag = (flag) => tokenLayers.find((l) => l.config?.plaid?.[flag]);
const sentenceLayer = byFlag('sentence');
const wordLayer = byFlag('primary');
const morphemeLayer = byFlag('morpheme');
const alignmentLayer = byFlag('alignment');

// 1. Tag substrate layers with their shared role.
await client.textLayers.setConfig(textLayer.id, 'plaid', 'role', ROLES.BASELINE);
if (sentenceLayer) await client.tokenLayers.setConfig(sentenceLayer.id, 'plaid', 'role', ROLES.SENTENCE);
if (wordLayer) await client.tokenLayers.setConfig(wordLayer.id, 'plaid', 'role', ROLES.WORD);
if (morphemeLayer) await client.tokenLayers.setConfig(morphemeLayer.id, 'plaid', 'role', ROLES.MORPHEME);
if (alignmentLayer) await client.tokenLayers.setConfig(alignmentLayer.id, 'plaid', 'role', ROLES.TIME_ALIGNMENT);

// 2. Private igt config: span-layer scopes (by name), word-layer orthographies +
//    ignored tokens, project metadata + initialized flag.
const scopeByName = { Gloss: 'Morpheme', 'Part of Speech': 'Word', Translation: 'Sentence' };
for (const parent of [wordLayer, morphemeLayer, sentenceLayer]) {
  for (const sl of parent?.spanLayers || []) {
    const scope = scopeByName[sl.name];
    if (scope) await client.spanLayers.setConfig(sl.id, 'igt', 'scope', scope);
  }
}
if (wordLayer) {
  await client.tokenLayers.setConfig(wordLayer.id, 'igt', 'orthographies', [{ name: 'IPA' }]);
  await client.tokenLayers.setConfig(wordLayer.id, 'igt', 'ignoredTokens', { type: 'unicodePunctuation', whitelist: [] });
}
await client.projects.setConfig(project.id, 'igt', 'documentMetadata', [{ name: 'Date' }, { name: 'Speakers' }]);
await client.projects.setConfig(project.id, 'igt', 'initialized', true);

console.log('Patched config for project', project.id);
console.log({ textLayer: textLayer.id, sentenceLayer: sentenceLayer?.id, wordLayer: wordLayer?.id, morphemeLayer: morphemeLayer?.id, alignmentLayer: alignmentLayer?.id });
