// Live e2e (TEST_PLAN C8-04): native import whose media upload FAILS once.
// The document must be left unmarked (metadata.nativeImported absent) so a
// re-import redoes it and recovers the media. Runs against the dev core.
//   cd plaid-igt && node e2e/native-media-resume-live.mjs
import { File } from 'node:buffer';
import { makeClient } from './bugbash/harness.mjs';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { findBaselineTextLayer } from '../src/domain/igtConfig.js';
import { deriveSetupData, runNativeImport } from '../src/import/native/importEngine.js';
import { discoverExportLayers } from '../src/export/exportLayers.js';
import { newPreset } from '../src/export/presets.js';
import { runExport } from '../src/export/runExport.js';
import { readNativeArchive } from '../src/import/native/readArchive.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${label}${ok || !detail ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};

const client = makeClient();
const created = [];
const deleteProjectWithVocabs = async (id) => {
  const p = await client.projects.get(id).catch(() => null);
  await client.projects.delete(id).catch(() => {});
  for (const v of p?.vocabs || []) await client.vocabLayers.delete(v.id).catch(() => {});
};
async function exportNative(projectId) {
  const project = await client.projects.get(projectId);
  const preset = newPreset('plaid-igt-json', discoverExportLayers(project), 'mr');
  const result = await runExport({ client, project, preset, scope: { type: 'project' } });
  return readNativeArchive(new Uint8Array(await result.blob.arrayBuffer()));
}

try {
  // ---- source project with one media-bearing document ----
  const nameA = `mr-a-${Date.now() % 1e7}`;
  const setupA = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: nameA },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [{ name: 'Gloss', scope: 'Morpheme', isCustom: true }],
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: { vocabularies: [] },
      documentMetadata: { enabledFields: [] },
    },
  });
  check(setupA.failures.length === 0, 'project A setup', setupA.failures.join('; '));
  created.push(setupA.projectId);
  const projectA = await client.projects.get(setupA.projectId);
  const baseline = findBaselineTextLayer(projectA.textLayers);
  const doc = await client.documents.create(setupA.projectId, 'Media doc');
  await client.texts.create(baseline.id, doc.id, 'Hello there world.');
  await client.documents.uploadMedia(
    doc.id,
    new File([new Uint8Array([82, 73, 70, 70, 0, 0])], 'clip.wav'),
  );
  const archive = await exportNative(setupA.projectId);
  check(
    archive.documents.length === 1 && !!archive.documents[0].mediaBytes,
    'archive embeds the media',
  );

  // ---- target project, first import with the media upload failing ----
  const nameB = `mr-b-${Date.now() % 1e7}`;
  const setupB = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: deriveSetupData(archive.manifest, nameB),
  });
  check(setupB.failures.length === 0, 'project B setup', setupB.failures.join('; '));
  created.push(setupB.projectId);

  const flaky = Object.create(client);
  flaky.documents = Object.create(client.documents);
  flaky.documents.uploadMedia = async () => {
    throw new Error('HTTP 500 simulated media failure');
  };
  const first = await runNativeImport({ client: flaky, projectId: setupB.projectId, archive });
  check(
    first.warnings.some((w) => /media upload failed/.test(w)),
    'first run warns that the media upload failed',
    first.warnings.join('; '),
  );
  const docs1 = await client.projects.listDocuments(setupB.projectId);
  check(docs1.length === 1, 'one document after the first run', `${docs1.length}`);
  const d1 = await client.documents.get(docs1[0].id);
  check(!d1.metadata?.nativeImported, 'document is left UNMARKED after the media failure');
  const archiveB1 = await exportNative(setupB.projectId);
  check(!archiveB1.documents[0]?.mediaBytes, 'no media on the half-imported document');

  // ---- resume with the real client ----
  const second = await runNativeImport({ client, projectId: setupB.projectId, archive });
  check(second.warnings.length === 0, 'resume has no warnings', second.warnings.join('; '));
  const docs2 = await client.projects.listDocuments(setupB.projectId);
  check(docs2.length === 1, 'resume did not duplicate the document', `${docs2.length} docs`);
  const d2 = await client.documents.get(docs2[0].id);
  check(!!d2.metadata?.nativeImported, 'document is marked imported after the resume');
  const archiveB2 = await exportNative(setupB.projectId);
  check(!!archiveB2.documents[0]?.mediaBytes, 'media recovered by the resume');
  check(
    archiveB2.documents[0]?.data.baseline?.body === 'Hello there world.',
    'text intact after the redo',
  );
} finally {
  for (const id of created) await deleteProjectWithVocabs(id);
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
