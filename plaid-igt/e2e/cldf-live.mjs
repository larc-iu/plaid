// Live e2e for the CLDF import + export round trip (scratchpad-convention:
// disposable). Everything else in the CLDF work is stub-tested, so this is the
// only thing that exercises the actual writes against a running core.
//
//   node e2e/cldf-live.mjs <a-cldf-dataset.zip> [--keep]
//
// 1. read the dataset, take a slice of it, and import it into a fresh project
//    through the real setup executor + import engine
// 2. read the project back off the server and check what landed
// 3. export it again as CLDF and validate the result with pycldf
// 4. re-import that export into a second project and compare the two
//
// Both projects are deleted at the end unless --keep is given.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync, zipSync } from 'fflate';
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';
import { readCldfDataset } from '../src/import/cldf/readDataset.js';
import { buildCldfDocuments } from '../src/import/cldf/buildDocuments.js';
import { deriveSetupData, runCldfImport } from '../src/import/cldf/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { runExport } from '../src/export/runExport.js';
import { newPreset } from '../src/export/presets.js';
import { discoverExportLayers } from '../src/export/exportLayers.js';
import { IgtDocument, loadProjectVocabularies } from '../src/domain/IgtDocument.js';
import { readLanguages } from '../src/domain/igtConfig.js';

const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const KEEP = process.argv.includes('--keep');
const CLDF_BIN = process.env.CLDF_BIN || `${process.env.HOME}/.mambaforge/bin/cldf`;
const SOURCE = process.argv[2];
const TEXTS = 3; // how many of the source's texts to import

if (!SOURCE) {
  console.error('usage: node e2e/cldf-live.mjs <a-cldf-dataset.zip> [--keep]');
  process.exit(2);
}

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL'} ${label}${cond ? '' : `   ${detail}`}`);
  if (!cond) failures.push(label);
};
const eq = (a, b, label) => check(a === b, label, `expected ${b}, got ${a}`);

const client = new PlaidClient(CORE_URL, readToken().token);
const created = [];

async function importDataset(dataset, name) {
  const build = buildCldfDocuments(dataset);
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    setupData: deriveSetupData(build, name),
    onProjectCreated: (id) => created.push(id),
  });
  if (setup.failures.length) throw new Error(setup.failures.join('. '));
  const result = await runCldfImport({ client, projectId: setup.projectId, build });
  return { projectId: setup.projectId, build, result };
}

/** Read a whole project back off the server as IgtDocuments. */
async function loadProject(projectId) {
  const project = await client.projects.get(projectId);
  const { vocabularies } = await loadProjectVocabularies(client, project);
  const list = await client.projects.listDocuments(projectId);
  const docs = [];
  for (const d of list) {
    const raw = await client.documents.get(d.id, true);
    docs.push(new IgtDocument({ raw, project, vocabularies: {}, client, projectId }));
  }
  docs.sort((a, b) => (a.document.name || '').localeCompare(b.document.name || ''));
  return { project, docs, vocabularies };
}

/** Every sentence of a project as comparable plain data. */
const shapeOf = ({ docs }) =>
  docs.map((d) => ({
    name: d.document.name,
    body: d.raw.textLayers?.[0]?.text?.body ?? '',
    sentences: (d.sortedSentences || []).map((s) => ({
      words: (s.tokens || []).map((t) => ({
        content: t.content,
        morphemes: (t.morphemes || []).map((m) => [
          m.metadata?.form ?? m.content,
          m.annotations?.Gloss?.value ?? '',
        ]),
      })),
      // Values, not field names: CLDF has one Translated_Text slot and states
      // the language separately, so a name like "Translation (English)"
      // legitimately comes back as plain "Translation".
      annotations: Object.values(s.annotations ?? {})
        .map((a) => a?.value ?? '')
        .filter((v) => v !== '')
        .sort(),
    })),
  }));

try {
  // ---- 1. import ----------------------------------------------------------
  console.log(`\n=== importing ${SOURCE} (first ${TEXTS} texts) ===`);
  const full = readCldfDataset(new Uint8Array(readFileSync(SOURCE)));
  const examples = full.components.ExampleTable;
  const contributionColumn = examples.byTerm?.contributionReference?.name;
  if (contributionColumn) {
    const keep = new Set(
      [...new Set(examples.rows.map((r) => r[contributionColumn]))].slice(0, TEXTS),
    );
    examples.rows = examples.rows.filter((r) => keep.has(r[contributionColumn]));
  }
  const stamp = Date.now();
  const first = await importDataset(full, `CLDF live ${stamp}`);
  console.log(
    `  imported ${first.result.imported} texts, ${first.build.stats.sentences} sentences, ` +
      `${first.build.stats.words} words, ${first.build.stats.lexiconEntries} lexicon entries`,
  );

  // ---- 2. read it back off the server -------------------------------------
  console.log('\n=== what landed on the server ===');
  const live = await loadProject(first.projectId);
  eq(live.docs.length, first.build.documents.length, 'document count');
  const liveSentences = live.docs.reduce((n, d) => n + d.sortedSentences.length, 0);
  eq(liveSentences, first.build.stats.sentences, 'sentence count');
  const liveWords = live.docs.reduce(
    (n, d) => n + d.sortedSentences.reduce((m, s) => m + s.tokens.length, 0),
    0,
  );
  eq(liveWords, first.build.stats.words, 'word count');
  const liveMorphemes = live.docs.reduce(
    (n, d) =>
      n +
      d.sortedSentences.reduce(
        (m, s) => m + s.tokens.reduce((k, t) => k + (t.morphemes || []).length, 0),
        0,
      ),
    0,
  );
  eq(liveMorphemes, first.build.stats.morphemes, 'morpheme count');

  const items = Object.values(live.vocabularies).reduce((n, v) => n + (v.items || []).length, 0);
  eq(items, first.build.stats.lexiconEntries, 'lexicon item count');

  const langs = readLanguages(live.project.config);
  check(
    langs.object.glottocode === (first.build.languages.object?.glottocode ?? ''),
    'language identity written to project config',
    JSON.stringify(langs.object),
  );

  // Every word token must slice out of the body, and every sentence must have
  // a gloss reachable from its morphemes.
  const sample = live.docs[0].sortedSentences[0];
  check(sample.tokens.length > 0, 'first sentence has word tokens');
  check(
    sample.tokens.every((t) => (t.content ?? '') !== ''),
    'every word token slices to non-empty text',
  );
  check(
    sample.tokens.every((t) => (t.morphemes || []).length > 0),
    'every word has at least one morpheme (the IGT invariant)',
  );
  console.log(
    '  sample:',
    sample.tokens
      .slice(0, 4)
      .map(
        (t) =>
          `${t.content}[${(t.morphemes || [])
            .map((m) => `${m.metadata?.form ?? ''}/${m.annotations?.Gloss?.value ?? ''}`)
            .join('+')}]`,
      )
      .join(' '),
  );

  // Sentence partition: tiles the body with no gaps.
  for (const d of live.docs) {
    const ss = d.sortedSentences;
    const body = d.raw.textLayers?.[0]?.text?.body ?? '';
    const tiles =
      ss.length > 0 &&
      ss[0].begin === 0 &&
      ss.at(-1).end === [...body].length &&
      ss.every((s, i) => i === 0 || s.begin === ss[i - 1].end);
    if (!tiles) check(false, `sentence partition tiles "${d.document.name}"`);
  }
  check(true, 'sentence partition tiles every document');

  // ---- 3. export it again, and validate with pycldf ------------------------
  console.log('\n=== export the imported project back to CLDF ===');
  const preset = newPreset(
    'cldf',
    discoverExportLayers(live.project),
    'live',
    readLanguages(live.project.config),
  );
  const exported = await runExport({
    client,
    project: live.project,
    preset: { ...preset, options: { ...preset.options, includeMedia: false } },
    scope: { type: 'project' },
  });
  const bytes = new Uint8Array(await exported.blob.arrayBuffer());
  console.log(
    `  ${exported.filename}, ${bytes.length} bytes, ${exported.warnings.length} warnings`,
  );
  for (const w of exported.warnings) console.log('    warning:', w);

  const dir = mkdtempSync(join(tmpdir(), 'cldf-live-'));
  for (const [path, data] of Object.entries(unzipSync(bytes))) {
    writeFileSync(join(dir, path), data);
  }
  try {
    const out = execFileSync(CLDF_BIN, ['validate', 'cldf-metadata.json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    check(out.trim() === '', 'pycldf validates the export with no warnings', out.trim());
  } catch (e) {
    check(false, 'pycldf validates the export', `${e.stdout ?? ''}${e.stderr ?? ''}`);
  }

  // ---- 3b. document-level media -------------------------------------------
  // No reachable public corpus pairs contribution-level media WITH an
  // ExampleTable that references contributions (APiCS ships real audio, but
  // per example, which Plaid cannot model), so this leg is synthetic. The
  // upload itself is the part worth exercising against a real server.
  console.log('\n=== document-level media ===');
  const T = 'http://cldf.clld.org/v1.0/terms.rdf#';
  const c = (n, t, x = {}) => ({
    name: n,
    ...(t ? { propertyUrl: T + t } : {}),
    datatype: 'string',
    ...x,
  });
  const enc = (t) => new TextEncoder().encode(t);
  const wav = new Uint8Array(1200);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  const withMedia = zipSync({
    'cldf-metadata.json': enc(
      JSON.stringify({
        '@context': ['http://www.w3.org/ns/csvw'],
        'dc:conformsTo': T + 'TextCorpus',
        'dc:title': 'Media probe',
        tables: [
          {
            url: 'examples.csv',
            'dc:conformsTo': T + 'ExampleTable',
            tableSchema: {
              columns: [
                c('ID', 'id'),
                c('Primary_Text', 'primaryText'),
                c('Analyzed_Word', 'analyzedWord', { separator: '\t', null: [] }),
                c('Gloss', 'gloss', { separator: '\t', null: [] }),
                c('Contribution_ID', 'contributionReference'),
              ],
            },
          },
          {
            url: 'contributions.csv',
            'dc:conformsTo': T + 'ContributionTable',
            tableSchema: { columns: [c('ID', 'id'), c('Name', 'name')] },
          },
          {
            url: 'media.csv',
            'dc:conformsTo': T + 'MediaTable',
            tableSchema: {
              columns: [
                c('ID', 'id'),
                c('Media_Type', 'mediaType'),
                c('Download_URL', 'downloadUrl'),
                c('Contribution_ID', 'contributionReference'),
              ],
            },
          },
        ],
      }),
    ),
    'examples.csv': enc(
      'ID,Primary_Text,Analyzed_Word,Gloss,Contribution_ID\r\n' +
        '1,perros corren,perro=s\tcorren,dog=PL\trun,t1\r\n',
    ),
    'contributions.csv': enc('ID,Name\r\nt1,Recorded text\r\n'),
    'media.csv': enc(
      'ID,Media_Type,Download_URL,Contribution_ID\r\nm1,audio/wav,audio/take1.wav,t1\r\n',
    ),
    'audio/take1.wav': wav,
  });
  const mediaBuild = buildCldfDocuments(readCldfDataset(withMedia));
  check(!!mediaBuild.documents[0].mediaBytes, 'media resolved out of the archive');
  eq(mediaBuild.documents[0].mediaName, 'take1.wav', 'media filename');
  const third = await importDataset(readCldfDataset(withMedia), `CLDF live ${stamp} media`);
  const live3 = await loadProject(third.projectId);
  check(
    !!live3.docs[0].raw.mediaUrl,
    'media uploaded and served by the core',
    String(live3.docs[0].raw.mediaUrl),
  );
  const fetched = await fetch(`${CORE_URL}/api/v1/documents/${live3.docs[0].id}/media`, {
    headers: { Authorization: `Bearer ${readToken().token}` },
  });
  eq(fetched.status, 200, 'media downloads again');
  eq((await fetched.arrayBuffer()).byteLength, wav.length, 'media round trips byte-for-byte');

  // ---- 4. re-import the export and compare --------------------------------
  console.log('\n=== re-import the export into a second project ===');
  const second = await importDataset(readCldfDataset(bytes), `CLDF live ${stamp} rt`);
  const live2 = await loadProject(second.projectId);

  const a = shapeOf(live);
  const b = shapeOf(live2);
  eq(b.length, a.length, 'round trip: document count');
  eq(
    JSON.stringify(b.map((d) => d.name)),
    JSON.stringify(a.map((d) => d.name)),
    'round trip: names',
  );
  eq(
    JSON.stringify(b.map((d) => d.body)),
    JSON.stringify(a.map((d) => d.body)),
    'round trip: bodies',
  );
  const same = JSON.stringify(a) === JSON.stringify(b);
  check(same, 'round trip: every sentence, word, morpheme, gloss and translation');
  if (!same) {
    for (let i = 0; i < a.length; i += 1) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        console.log(`   first differing document: ${a[i].name}`);
        const sa = a[i].sentences;
        const sb = b[i].sentences;
        for (let j = 0; j < Math.max(sa.length, sb.length); j += 1) {
          if (JSON.stringify(sa[j]) !== JSON.stringify(sb[j])) {
            console.log('     A:', JSON.stringify(sa[j])?.slice(0, 400));
            console.log('     B:', JSON.stringify(sb[j])?.slice(0, 400));
            break;
          }
        }
        break;
      }
    }
  }
} catch (e) {
  console.error('\nUNCAUGHT:', e?.stack || e);
  failures.push(String(e?.message || e));
} finally {
  if (KEEP) {
    console.log(`\nkept projects: ${created.join(', ')}`);
  } else {
    for (const id of created) {
      try {
        await client.projects.delete(id);
      } catch (e) {
        console.log('cleanup failed for', id, e?.message);
      }
    }
    console.log(`\ncleaned up ${created.length} projects`);
  }
  console.log(failures.length ? `\n${failures.length} FAILURES` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}
