// Live round-trip e2e for the native format (scratchpad-convention:
// disposable). Pipeline against the live core (:8085):
//
//   1. FLEx-import a 2-text Lezgi slice into project A (real importer)
//      + add media and a time-alignment token to one document
//   2. Export A as a Plaid IGT JSON archive
//   3. Import that archive into a fresh project B (the native importer)
//   4. Export B the same way
//   5. Compare the two archives SEMANTICALLY (ids are correlation keys, so
//      both sides are normalized to id-free shapes; the importer's bookkeeping
//      stamps — nativeImportId, nativeImported — are stripped)
//
//   node e2e/native-roundtrip-live.mjs [--keep]
//
// Projects are deleted at the end unless --keep is given.
//
// History worth keeping: on 2026-08-31 this script was OOM-killed three times
// at ~20 GB and took unrelated processes on the machine down with it. It was
// NOT a leak in the pipeline (that peaks around 650 MB). It was
// assert.deepEqual: the vocabularies genuinely differed, and node builds its
// failure message by diffing the two structures at a cost quadratic in the
// EDIT DISTANCE. One changed element formats in 141ms; the same 4,591 elements
// in a DIFFERENT ORDER never finished. The mismatch itself was real, an
// export-side id sort that shuffled every batch (see serializeVocabularyNative).
// Both are fixed. `compare` below is now bounded, so keep it that way.
//
// To cap a heavy run, use a cgroup, NOT `ulimit -v`: node reserves far more
// virtual address space than it resides in (38 GB vs 19.5 GB in the OOM
// record), so a -v limit strangles it at startup instead of bounding it.
//   systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 \
//     node e2e/native-roundtrip-live.mjs

import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import { makeClient } from './bugbash/harness.mjs';
import { readFwbackup } from '../src/import/flex/fwbackup.js';
import { parseFwdata } from '../src/import/flex/fwdataParser.js';
import { buildDocuments } from '../src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../src/import/flex/importEngine.js';
import { executeProjectSetup } from '../src/components/projects/setup/executeSetup.js';
import { findBaselineTextLayer, findAlignmentTokenLayer } from '../src/domain/igtConfig.js';
import { discoverExportLayers } from '../src/export/exportLayers.js';
import { newPreset } from '../src/export/presets.js';
import { runExport } from '../src/export/runExport.js';
import { readNativeArchive } from '../src/import/native/readArchive.js';
import { stripAttribution } from '../src/import/native/commentAttribution.js';
import { deriveSetupData, runNativeImport } from '../src/import/native/importEngine.js';

const BACKUP = '/home/luke/Downloads/fwbackup/lezgi.fwbackup';
const KEEP = process.argv.includes('--keep');

// Key order is not a difference (deepEqual never treated it as one), so the
// cheap equality check canonicalizes it away.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(',')}}`;
}

// A bounded description of how two structures differ: walks both, stops after
// a handful of findings, and never formats a whole structure.
function describeMismatch(a, b, limit = 6) {
  const out = [];
  (function walk(x, y, path) {
    if (out.length >= limit || x === y) return;
    const t = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    if (t(x) !== t(y)) return void out.push(`${path}: ${t(x)} vs ${t(y)}`);
    if (t(x) === 'array') {
      if (x.length !== y.length) out.push(`${path}.length: ${x.length} vs ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`);
      return;
    }
    if (t(x) === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!(k in x)) out.push(`${path}.${k}: missing on the left`);
        else if (!(k in y)) out.push(`${path}.${k}: missing on the right`);
        else walk(x[k], y[k], `${path}.${k}`);
      }
      return;
    }
    const s = (v) => String(JSON.stringify(v)).slice(0, 60);
    out.push(`${path}: ${s(x)} vs ${s(y)}`);
  })(a, b, '');
  return out.length >= limit ? `${out.join('; ')} (and more)` : out.join('; ');
}

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures.push(label);
};

const client = makeClient();
const t0 = Date.now();
const createdProjects = [];

// ---- helpers ----------------------------------------------------------------

async function exportNative(projectId, expectedWarnings = []) {
  const project = await client.projects.get(projectId);
  const preset = newPreset('plaid-igt-json', discoverExportLayers(project), 'rt');
  const result = await runExport({ client, project, preset, scope: { type: 'project' } });
  check(
    stableStringify(result.warnings) === stableStringify(expectedWarnings),
    expectedWarnings.length
      ? `export of ${project.name} warns exactly as expected`
      : `export of ${project.name} has no warnings`,
    result.warnings.join('; '),
  );
  return readNativeArchive(new Uint8Array(await result.blob.arrayBuffer()));
}

// Id-free canonical form of an archive for deep comparison. Token references
// become extent descriptors; vocab item references become forms; the
// importer's bookkeeping metadata is stripped.
function normalize(archive) {
  const omit = (obj, keys) => {
    if (!obj) return undefined;
    const out = Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
    return Object.keys(out).length ? out : undefined;
  };
  const itemFormById = new Map();
  for (const v of archive.vocabularies) {
    for (const it of v.data.items || []) itemFormById.set(it.id, it.form);
  }
  const vocabularies = archive.vocabularies
    .map((v) => ({
      name: v.name,
      fields: v.data.fields,
      items: (v.data.items || []).map((it) => ({
        form: it.form,
        metadata: omit(it.metadata, ['nativeImportId']),
      })),
      // The entry a comment hangs off, by form, plus the words a person typed
      // (see the document comments below for why author and dates are not here).
      comments: (v.data.comments || [])
        .map((c) => ({
          entry: itemFormById.get(c.anchor?.id) ?? `unknown:${c.anchor?.id}`,
          anchorLabel: c.anchorLabel,
          body: stripAttribution(c.body),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const documents = archive.documents
    .map((d) => {
      const data = d.data;
      const tokenDesc = new Map(); // token id → "layer:begin-end[:precedence]"
      const note = (id, s) => {
        if (id != null) tokenDesc.set(id, s);
      };
      for (const s of data.sentences || []) {
        note(s.id, `sentence:${s.begin}-${s.end}`);
        for (const w of s.words || []) {
          note(w.id, `word:${w.begin}-${w.end}`);
          for (const m of w.morphemes || [])
            note(m.id, `morpheme:${m.begin}-${m.end}:${m.precedence}`);
        }
      }
      for (const t of data.orphanTokens || []) note(t.id, `${t.layer}:${t.begin}-${t.end}`);
      for (const a of data.alignment || []) note(a.id, `alignment:${a.begin}-${a.end}`);
      const desc = (id) => tokenDesc.get(id) ?? `unknown:${id}`;

      // Span id → "field=value", so a comment anchored to an annotation
      // compares by what it hangs off rather than by a correlation key.
      const spanDesc = new Map();
      const noteSpan = (name, e) => {
        if (e?.id != null) spanDesc.set(e.id, `${name}=${e.value}`);
      };
      for (const sn of data.sentences || []) {
        for (const [n, e] of Object.entries(sn.fields || {})) noteSpan(n, e);
        for (const w of sn.words || []) {
          for (const [n, e] of Object.entries(w.fields || {})) noteSpan(n, e);
          for (const m of w.morphemes || [])
            for (const [n, e] of Object.entries(m.fields || {})) noteSpan(n, e);
        }
      }
      for (const sp of data.extraSpans || []) noteSpan(sp.layer?.name ?? 'span', sp);
      const anchorDesc = (a) => {
        if (a?.type === 'token') return `token:${desc(a.id)}`;
        if (a?.type === 'span') return `span:${spanDesc.get(a.id) ?? `unknown:${a.id}`}`;
        return a?.type ?? 'unknown';
      };

      const fields = (f) =>
        Object.fromEntries(
          Object.entries(f || {}).map(([name, e]) => [
            name,
            { value: e.value, metadata: e.metadata },
          ]),
        );
      const vocab = (v) =>
        v ? { form: itemFormById.get(v.itemId) ?? v.itemId, metadata: v.metadata } : undefined;

      return {
        name: d.name,
        metadata: omit(data.metadata, ['nativeImported']),
        body: data.baseline?.body,
        hasMedia: !!d.mediaBytes,
        sentences: (data.sentences || []).map((s) => ({
          begin: s.begin,
          end: s.end,
          metadata: s.metadata,
          fields: fields(s.fields),
          words: (s.words || []).map((w) => ({
            begin: w.begin,
            end: w.end,
            text: w.text,
            orthographies: w.orthographies,
            metadata: w.metadata,
            fields: fields(w.fields),
            vocab: vocab(w.vocab),
            morphemes: (w.morphemes || []).map((m) => ({
              begin: m.begin,
              end: m.end,
              precedence: m.precedence,
              text: m.text,
              ...('form' in m ? { form: m.form } : {}),
              ...('morphType' in m ? { morphType: m.morphType } : {}),
              metadata: m.metadata,
              fields: fields(m.fields),
              vocab: vocab(m.vocab),
            })),
          })),
        })),
        alignment: (data.alignment || []).map((a) => ({
          begin: a.begin,
          end: a.end,
          timeBegin: a.timeBegin,
          timeEnd: a.timeEnd,
          metadata: a.metadata,
        })),
        extraVocabLinks: (data.extraVocabLinks || [])
          .map((l) => ({
            form: itemFormById.get(l.itemId) ?? l.itemId,
            tokens: (l.tokens || []).map(desc).sort(),
            metadata: l.metadata,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        extraSpans: (data.extraSpans || [])
          .map((s) => ({
            layer: s.layer,
            tokens: (s.tokens || []).map(desc).sort(),
            value: s.value,
            metadata: s.metadata,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        orphanTokens: (data.orphanTokens || [])
          .map((t) => ({
            layer: t.layer,
            begin: t.begin,
            end: t.end,
            precedence: t.precedence,
            metadata: t.metadata,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        // Anchor + the words a person typed. Author and timestamps are
        // DELIBERATELY excluded: the server restamps both on import, which is
        // the whole reason the importer writes an attribution note instead.
        // That the note is present is checked separately.
        comments: (data.comments || [])
          .map((c) => ({
            anchor: anchorDesc(c.anchor),
            anchorLabel: c.anchorLabel,
            body: stripAttribution(c.body),
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { schema: archive.manifest.schema, vocabularies, documents };
}

try {
  // ---- 1. project A via the FLEx importer ----
  const { xml } = readFwbackup(new Uint8Array(readFileSync(BACKUP)));
  const ir = parseFwdata(xml);
  const build = buildDocuments(ir);
  build.documents = [...build.documents]
    .sort((a, b) => a.words.length - b.words.length)
    .slice(0, 2);
  const config = {
    ...deriveImportConfig(ir, build),
    orthographies: [{ ws: 'lez-Qaaa-AZ-x-Tran-lat', name: 'Translit' }],
  };
  const nameA = `rt-a-${Date.now() % 1e7}`;
  const setupA = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: nameA },
      orthographies: {
        orthographies: [
          { name: 'Baseline', isBaseline: true },
          ...config.orthographies.map((o) => ({ name: o.name })),
        ],
      },
      fields: {
        fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      },
      vocabulary: {
        vocabularies: [{ id: 'new-flex', name: `${nameA} Lexicon`, enabled: true, isCustom: true }],
      },
      documentMetadata: {
        enabledFields: config.documentMetadata.map((m) => ({
          name: m.name,
          enabled: true,
          isCustom: true,
        })),
      },
    },
  });
  check(setupA.failures.length === 0, 'project A setup', setupA.failures.join('; '));
  createdProjects.push(setupA.projectId);
  await runImport({
    client,
    projectId: setupA.projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId: setupA.resources.vocabularies[0].id,
  });
  console.log(`project A imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Media + one sentence-extent alignment token on the first document, so the
  // round-trip exercises both.
  const projectA = await client.projects.get(setupA.projectId);
  const docsA = await client.projects.listDocuments(setupA.projectId);
  const docA = await client.documents.get(docsA[0].id, true);
  const baselineA = findBaselineTextLayer(docA.textLayers);
  const alignLayerA = findAlignmentTokenLayer(
    findBaselineTextLayer(projectA.textLayers).tokenLayers || [],
  );
  const sentA = baselineA.tokenLayers
    .find((tl) => tl.config?.plaid?.role === 'sentence')
    .tokens.sort((a, b) => a.begin - b.begin)[0];
  await client.documents.uploadMedia(
    docsA[0].id,
    new File([new Uint8Array([82, 73, 70, 70, 0, 0])], 'rt.wav'),
  );
  await client.tokens.bulkCreate([
    {
      tokenLayerId: alignLayerA.id,
      text: baselineA.text.id,
      begin: sentA.begin,
      end: sentA.end,
      metadata: { timeBegin: 0.5, timeEnd: 2.25 },
    },
  ]);

  // Comments on each anchor type the archive can represent, so the round trip
  // exercises document / text / token / span resolution rather than just one.
  const spanA = baselineA.tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .flatMap((sl) => sl.spans || [])[0];
  check(!!spanA, 'project A has a span to comment on');
  const seededComments = [
    ['document', docsA[0].id, 'Whole-document note: check the speaker attribution.'],
    ['text', baselineA.text.id, 'The baseline has a stray character near the end.'],
    ['token', sentA.id, 'Is this really one sentence?'],
    ...(spanA ? [['span', spanA.id, 'This gloss looks like a typo.']] : []),
  ];
  for (const [type, id, body] of seededComments) {
    await client.comments.create(type, id, body);
  }
  const commentsA = await client.comments.list(setupA.projectId);
  check(
    commentsA.length === seededComments.length,
    'project A has the seeded comments',
    `${commentsA.length} vs ${seededComments.length}`,
  );

  // A comment on a lexicon entry rides the vocabulary file, with the caption
  // it was posted under.
  const vocabIdA = setupA.resources.vocabularies[0].id;
  const entryA = (await client.vocabLayers.get(vocabIdA, true)).items[0];
  check(!!entryA, 'project A has a lexicon entry to comment on');
  const entryComment = { body: 'Is this a loan?', anchorLabel: `Entry ${entryA?.form}` };
  if (entryA) {
    await client.comments.create('vocab-item', entryA.id, entryComment.body, {
      anchorLabel: entryComment.anchorLabel,
    });
  }

  // A comment outlives its anchor. One on an annotation that is then deleted
  // must be dropped at export, counted in a warning, rather than carried where
  // a re-importer could not hang it.
  const spanGone = baselineA.tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .flatMap((sl) => sl.spans || [])
    .find((sp) => sp.id !== spanA?.id);
  check(!!spanGone, 'project A has a second span to comment on and delete');
  if (spanGone) {
    await client.comments.create('span', spanGone.id, 'This will outlive its annotation.');
    await client.spans.delete(spanGone.id);
  }
  const expectedExportWarnings = spanGone
    ? [
        `"${docsA[0].name}": 1 comment not exported (what they are about is deleted, or belongs to another app)`,
      ]
    : [];

  // Project config the FLEx importer never sets, and one governed field. All
  // of this used to be dropped by the archive, so without seeding it here the
  // schema comparison below compares two sets of nulls and proves nothing.
  const projectABefore = await client.projects.get(setupA.projectId);
  // Gloss exists at BOTH Word and Morpheme scope, so pick by scope, not name.
  const glossLayer = (projectABefore.textLayers || [])
    .flatMap((tl) => tl.tokenLayers || [])
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.name === 'Gloss' && sl.config?.igt?.scope === 'Morpheme');
  check(!!glossLayer, 'project A has a morpheme-scope Gloss field to govern');
  await client.projects.setConfig(setupA.projectId, 'igt', 'tagsets', {
    Leipzig: { delimiters: '.:', mode: 'mixed', values: [{ value: 'PL' }, { value: 'NOM' }] },
  });
  await client.projects.setConfig(setupA.projectId, 'igt', 'languages', {
    object: { name: 'Lezgi', glottocode: 'lezg1247', iso639P3: 'lez' },
    meta: { name: 'English', glottocode: 'stan1293', iso639P3: 'eng' },
  });
  await client.projects.setConfig(setupA.projectId, 'igt', 'speakers', ['Speaker 1', 'Speaker 2']);
  await client.projects.setConfig(setupA.projectId, 'igt', 'serviceDefaults', {
    analyze: { impl: 'polygloss' },
  });
  await client.projects.setConfig(setupA.projectId, 'igt', 'export', {
    presets: [{ name: 'For the paper', format: 'latex' }],
  });
  await client.spanLayers.setConfig(glossLayer.id, 'igt', 'tagset', 'Leipzig');

  // ---- 2. export A ----
  const archiveA = await exportNative(setupA.projectId, expectedExportWarnings);
  check(
    archiveA.manifest.schema.tagsets?.Leipzig != null,
    'archive A carries the tagsets',
    JSON.stringify(archiveA.manifest.schema.tagsets),
  );
  const governedIn = Object.entries(archiveA.manifest.schema.fields)
    .flatMap(([scope, fs]) => fs.filter((f) => f.tagset).map((f) => `${scope}:${f.name}`))
    .sort();
  check(
    governedIn.join() === 'morpheme:Gloss',
    "archive A carries the Gloss field's tagset reference, on that field alone",
    `governed: [${governedIn.join(', ')}]`,
  );
  const archivedComments = archiveA.documents.flatMap((d) => d.data.comments || []);
  check(
    archivedComments.length === seededComments.length,
    'archive A carries every comment',
    `${archivedComments.length} vs ${seededComments.length}`,
  );
  check(
    archivedComments.every((c) => c.author?.id && c.createdAt && c.updatedAt),
    'archived comments record author and both timestamps',
  );
  const archivedEntryComments = archiveA.vocabularies.flatMap((v) => v.data.comments || []);
  check(
    archivedEntryComments.length === 1 &&
      archivedEntryComments[0].anchor.type === 'vocab-item' &&
      archivedEntryComments[0].anchor.id === entryA?.id &&
      archivedEntryComments[0].anchorLabel === entryComment.anchorLabel &&
      archivedEntryComments[0].body === entryComment.body,
    'the vocabulary file carries the entry comment, with its caption',
    JSON.stringify(archivedEntryComments).slice(0, 200),
  );
  check(
    archiveA.documents.some((d) => d.mediaBytes),
    'archive A embeds the media file',
  );
  check(
    archiveA.documents.some((d) => d.data.alignment.length === 1),
    'archive A carries the alignment token',
  );

  // ---- 3. import into project B ----
  const nameB = `rt-b-${Date.now() % 1e7}`;
  const setupB = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: deriveSetupData(archiveA.manifest, nameB),
  });
  check(setupB.failures.length === 0, 'project B setup', setupB.failures.join('; '));
  createdProjects.push(setupB.projectId);
  const importRes = await runNativeImport({
    client,
    projectId: setupB.projectId,
    archive: archiveA,
    onProgress: (p) => {
      if (p.phase === 'document' && p.step === 'Starting') {
        console.log(`  importing ${p.index + 1}/${p.total} ${p.doc}`);
      }
    },
  });
  check(
    importRes.warnings.length === 0,
    'native import has no warnings',
    importRes.warnings.join('; '),
  );
  check(importRes.imported === archiveA.documents.length, 'all documents imported');

  // Attribution: the server restamps author and dates, so what must survive is
  // the note. Checked here rather than in the archive comparison, which
  // deliberately strips it to compare the words themselves.
  const commentsB = await client.comments.list(setupB.projectId);
  check(
    commentsB.length === seededComments.length,
    'project B has every comment back',
    `${commentsB.length} vs ${seededComments.length}`,
  );
  check(
    commentsB.every((c) => c.body.startsWith('> Imported from an archive. Originally posted by ')),
    'every imported comment opens with its original attribution',
    commentsB.map((c) => c.body.slice(0, 60)).join(' | '),
  );
  const originalAuthor = commentsA[0]?.authorId;
  check(
    !!originalAuthor && commentsB.every((c) => c.body.includes(originalAuthor)),
    'the note names the original author',
  );
  check(
    new Set(commentsB.map((c) => c.entityType)).size ===
      new Set(seededComments.map((c) => c[0])).size,
    'every anchor type resolved on import',
    [...new Set(commentsB.map((c) => c.entityType))].join(','),
  );
  const vocabIdB = setupB.resources.vocabularies[0].id;
  const entryCommentsB = await client.comments.listInVocab(vocabIdB);
  const entryB = entryCommentsB[0]
    ? await client.vocabItems.get(entryCommentsB[0].entityId).catch(() => null)
    : null;
  check(
    entryCommentsB.length === 1 &&
      entryCommentsB[0].entityType === 'vocab-item' &&
      entryCommentsB[0].anchorLabel === entryComment.anchorLabel &&
      stripAttribution(entryCommentsB[0].body) === entryComment.body &&
      entryCommentsB[0].body.startsWith('> Imported from an archive. Originally posted by ') &&
      entryB?.form === entryA?.form,
    'project B has the entry comment back, on the same entry, with its caption and attribution',
    JSON.stringify(entryCommentsB).slice(0, 200),
  );

  // ---- 4 + 5. export B and compare ----
  const archiveB = await exportNative(setupB.projectId);
  const normA = normalize(archiveA);
  const normB = normalize(archiveB);

  // NEVER assert.deepEqual two big structures. Node builds the failure message
  // by diffing them, and the cost is quadratic in the EDIT DISTANCE, not the
  // size: one changed element formats in 141ms, whereas the same 4,591 elements
  // in a different order ran past 20 GB and got the whole machine OOM-killed
  // (three times, taking unrelated processes with it). Compare cheaply first
  // and only ever describe a mismatch in bounded terms.
  const compare = (label, a, b) => {
    if (stableStringify(a) === stableStringify(b)) return check(true, label);
    check(false, label, describeMismatch(a, b));
  };
  compare('schema round-trips', normA.schema, normB.schema);
  compare(
    'vocabularies round-trip (forms, fields, metadata, ORDER)',
    normA.vocabularies,
    normB.vocabularies,
  );
  normA.documents.forEach((dA, i) => {
    compare(`document "${dA.name}" round-trips`, dA, normB.documents[i]);
  });
  check(
    normB.documents.some((d) => d.hasMedia),
    'media survived the round trip',
  );
  check(
    normB.documents.some(
      (d) =>
        d.alignment.length === 1 &&
        d.alignment[0].timeBegin === 0.5 &&
        d.alignment[0].timeEnd === 2.25,
    ),
    'alignment times survived the round trip',
  );

  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s; ${failures.length} failure(s)`);
} finally {
  if (!KEEP) {
    for (const id of createdProjects) {
      await deleteProjectWithVocabs(id);
    }
    console.log(
      `${createdProjects.length} project(s) + their vocabs deleted (use --keep to keep them)`,
    );
  } else {
    console.log(`kept projects: ${createdProjects.join(', ')}`);
  }
}

if (failures.length) {
  console.error('FAILURES:', failures);
  process.exit(1);
}

// Delete a project AND the vocabs linked to it (vocabs are project-independent,
// so deleting the project alone leaves orphan lexicons behind).
async function deleteProjectWithVocabs(id) {
  const vocabIds = await client.projects
    .get(id)
    .then((p) => (p.vocabs || []).map((v) => v.id))
    .catch(() => []);
  await client.projects.delete(id).catch((e) => console.log('cleanup failed:', e.message));
  for (const vid of vocabIds) {
    await client.vocabLayers
      .delete(vid)
      .catch((e) => console.log('vocab cleanup failed:', e.message));
  }
}
