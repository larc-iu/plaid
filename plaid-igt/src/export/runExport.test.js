import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport, ExportCancelled } from './runExport.js';
import { READS_IN_FLIGHT } from '../domain/documentReads.js';
import { discoverExportLayers } from './exportLayers.js';
import { newPreset } from './presets.js';

// ---- minimal raw IGT document + project fixtures ---------------------------

const role = (r) => ({ plaid: { role: r } });

// One sentence covering the whole body, one word token per space-separated run.
function rawDoc(id, name, body, mediaUrl = null) {
  const words = [];
  let begin = 0;
  for (const w of body.split(' ')) {
    words.push({ id: `${id}-w${begin}`, begin, end: begin + [...w].length });
    begin += [...w].length + 1;
  }
  return {
    id,
    name,
    mediaUrl,
    textLayers: [
      {
        config: role('baseline'),
        text: { body },
        tokenLayers: [
          { config: role('word'), tokens: words, spanLayers: [] },
          {
            config: role('sentence'),
            tokens: [{ id: `${id}-s`, begin: 0, end: [...body].length }],
            spanLayers: [],
          },
        ],
      },
    ],
  };
}

const PROJECT = {
  id: 'p1',
  name: 'My Project: Test',
  textLayers: [
    {
      config: role('baseline'),
      tokenLayers: [
        { config: role('word'), spanLayers: [] },
        { config: role('sentence'), spanLayers: [] },
      ],
    },
  ],
  vocabs: [{ id: 'v1' }],
};

const VOCAB = {
  id: 'v1',
  name: 'Lexicon',
  config: { igt: { fields: { gloss: { inline: true }, form: { inline: true } } } },
  items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog' } }],
  vocabLinks: [],
};

function stubClient({
  docs,
  vocab = VOCAB,
  vocabThen = null,
  failIds = [],
  vocabFails = false,
  comments = {},
  vocabComments = {},
  users = {},
  commentsFail = false,
  vocabCommentsFail = false,
  guidelines = [],
  guidelinesFail = false,
  delays = {},
  // Reads that fail with a transient error the first n times: { 'documents.get': n, ... }.
  flaky = {},
}) {
  const calls = [];
  const left = { ...flaky };
  const blip = (name) => {
    if (!left[name]) return;
    left[name] -= 1;
    // A dropped connection, as fetch reports it, or a gateway's 502.
    throw left[name] % 2
      ? new TypeError('Failed to fetch')
      : Object.assign(new Error('HTTP 502'), { status: 502 });
  };
  // The `layers` each document read named, by document id.
  const readLayers = new Map();
  return {
    calls,
    readLayers,
    guidelines: {
      list: async (projectId, opts) => {
        calls.push(['guidelines.list', projectId, opts]);
        blip('guidelines.list');
        if (guidelinesFail) throw new Error('guideline boom');
        return guidelines;
      },
    },
    comments: {
      list: async (projectId, { documentId } = {}) => {
        calls.push(['comments.list', projectId, documentId]);
        blip('comments.list');
        if (commentsFail) throw new Error('comment boom');
        return comments[documentId] || [];
      },
      listInVocab: async (vocabId) => {
        calls.push(['comments.listInVocab', vocabId]);
        blip('comments.listInVocab');
        if (vocabCommentsFail) throw new Error('vocab comment boom');
        return vocabComments[vocabId] || [];
      },
    },
    users: {
      get: async (id) => {
        calls.push(['users.get', id]);
        if (!(id in users)) throw new Error('no such user');
        return { id, displayName: users[id] };
      },
    },
    projects: {
      listDocuments: async (id) => {
        calls.push(['listDocuments', id]);
        return docs.map((d) => ({ id: d.id, name: d.name }));
      },
    },
    documents: {
      get: async (id, full, asOf, layers) => {
        calls.push(asOf ? ['documents.get', id, asOf] : ['documents.get', id]);
        readLayers.set(id, layers ?? null);
        if (delays[id]) await new Promise((r) => setTimeout(r, delays[id]));
        blip('documents.get');
        if (failIds.includes(id)) throw new Error('boom');
        return JSON.parse(JSON.stringify(docs.find((d) => d.id === id)));
      },
    },
    vocabLayers: {
      get: async (id, includeItems, asOf) => {
        // A read without the entries is the vocabulary's time, which the
        // copy kept between reads is checked against (vocabCache.js). Only
        // the reads of the entries are counted.
        if (!includeItems) return { id, timeModified: null };
        calls.push(asOf ? ['vocabLayers.get', id, asOf] : ['vocabLayers.get', id]);
        blip('vocabLayers.get');
        if (vocabFails) throw new Error('vocab boom');
        return JSON.parse(JSON.stringify(asOf && vocabThen ? vocabThen : vocab));
      },
    },
  };
}

const plainPreset = () => newPreset('plaintext', discoverExportLayers(PROJECT), 'p');
const unzipBlob = async (blob) => unzipSync(new Uint8Array(await blob.arrayBuffer()));

describe('runExport', () => {
  it('exports a whole project as a zip of per-document files, sequentially', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Alpha', 'ba')];
    const client = stubClient({ docs });
    const progress = [];
    const result = await runExport({
      client,
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'project' },
      onProgress: (p) => progress.push(p),
    });
    expect(result.filename).toBe('My Project Test-export.zip');
    expect(result.warnings).toEqual([]);
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['documents/Alpha (2).txt', 'documents/Alpha.txt']);
    expect(new TextDecoder().decode(entries['documents/Alpha.txt'])).toContain('hi  yo');
    // Sequential fetch order, after a single listDocuments.
    expect(client.calls).toEqual([
      ['listDocuments', 'p1'],
      ['documents.get', 'd1'],
      ['documents.get', 'd2'],
    ]);
    expect(progress.at(-1)).toEqual({ done: 2, total: 2, name: null });
  });

  it('exports a single document as a bare file without listing', async () => {
    const docs = [rawDoc('d1', 'Solo Doc', 'hi')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo Doc.txt');
    expect(await result.blob.text()).toContain('Solo Doc');
    expect(client.calls).toEqual([['documents.get', 'd1']]);
  });

  it('names a one-document selection after that document at every format', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi'), rawDoc('d2', 'Beta', 'ba')];
    const result = await runExport({
      client: stubClient({ docs }),
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'documents', ids: ['d2'] },
    });
    // Still a zip: that scope can carry the project's vocabularies too.
    expect(result.filename).toBe('Beta-export.zip');
    expect(Object.keys(await unzipBlob(result.blob))).toEqual(['documents/Beta.txt']);
  });

  // Two documents chosen, or the whole project of a one-document project: the
  // project names the file.
  it('names a multi-document selection after the project', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi'), rawDoc('d2', 'Beta', 'ba')];
    const result = await runExport({
      client: stubClient({ docs }),
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'documents', ids: ['d1', 'd2'] },
    });
    expect(result.filename).toBe('My Project Test-export.zip');
  });

  it('names a whole-project export after the project even with one document', async () => {
    const result = await runExport({
      client: stubClient({ docs: [rawDoc('d1', 'Alpha', 'hi')] }),
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'project' },
    });
    expect(result.filename).toBe('My Project Test-export.zip');
  });

  it('pairs the flextext with the lexicon as LIFT', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Flex-flex.zip');
    const files = await unzipBlob(result.blob);
    // No category anywhere in the fixture vocabulary, so no ranges sidecar.
    expect(Object.keys(files).sort()).toEqual(['Flex.flextext', 'Flex.lift', 'README.txt']);
    const lift = new TextDecoder().decode(files['Flex.lift']);
    const dom = new DOMParser().parseFromString(lift, 'text/xml');
    expect(dom.querySelector('parsererror')).toBeNull();
    expect(dom.querySelector('lexical-unit text').textContent).toBe('perro');
    const readme = new TextDecoder().decode(files['README.txt']);
    expect(readme).toContain('Flex.lift: the lexicon (1 entry, 1 sense)');
    expect(readme).toContain('Flex.flextext: 1 interlinear text');
  });

  // The cf and hn of a morph are read off the lexicon ENTRY, which is only in
  // the project's vocabularies: the item embedded in the document GET is a
  // bare {id, form} with no metadata. When the export handed each document an
  // empty vocabularies map, cf silently fell back to the undecorated citation
  // form, and FLEx matched no bound morph in the file.
  it('reads cf and hn off the project lexicon, not the embedded link item', async () => {
    const doc = rawDoc('d1', 'Flex', 'perro');
    doc.textLayers[0].tokenLayers.push({
      config: role('morpheme'),
      tokens: [{ id: 'm1', begin: 0, end: 5, metadata: { form: 'perro', morphType: 'suffix' } }],
      spanLayers: [],
      vocabs: [
        {
          id: 'v1',
          name: 'Lexicon',
          // What the server embeds: the item, stripped of its metadata.
          vocabLinks: [{ id: 'l1', tokens: ['m1'], vocabItem: { id: 'i1', form: 'perro' } }],
        },
      ],
    });
    const vocab = {
      ...VOCAB,
      items: [
        {
          id: 'i1',
          form: 'perro',
          metadata: { gloss: 'dog', lexemeForm: 'perr', morphType: 'suffix', homograph: 2 },
        },
      ],
    };
    // This project has a morpheme layer under its word layer; the shared one
    // stops at words, and there is no morph to carry a cf without it.
    const project = JSON.parse(JSON.stringify(PROJECT));
    project.textLayers[0].tokenLayers.push({ config: role('morpheme'), spanLayers: [] });
    const client = stubClient({ docs: [doc], vocab });
    const preset = newPreset('flextext', discoverExportLayers(project), 'f');
    const result = await runExport({
      client,
      project,
      preset,
      scope: { type: 'document', id: 'd1' },
    });
    const files = await unzipBlob(result.blob);
    const xml = new TextDecoder().decode(files['Flex.flextext']);
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    const morph = dom.querySelector('morph');
    // The lexeme form, decorated as the suffix it is — not the citation form.
    expect(morph.querySelector('item[type="cf"]').textContent).toBe('-perr');
    expect(morph.querySelector('item[type="hn"]').textContent).toBe('2');
  });

  it('reads a promoted example out of a document the scope does not cover', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo'), rawDoc('d2', 'Other', 'ba do')];
    const vocab = {
      ...VOCAB,
      items: [
        {
          id: 'i1',
          form: 'perro',
          metadata: { gloss: 'dog', examples: [{ document: 'd2', token: 'd2-w0' }] },
        },
      ],
    };
    const client = stubClient({ docs, vocab });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const progress = [];
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'document', id: 'd1' },
      onProgress: (p) => progress.push(p),
    });
    const files = await unzipBlob(result.blob);
    const dom = new DOMParser().parseFromString(
      new TextDecoder().decode(files['Flex.lift']),
      'text/xml',
    );
    expect(dom.querySelector('example form text').textContent).toBe('ba do');
    // The example document was fetched, and counted in the progress total.
    expect(client.calls).toContainEqual(['documents.get', 'd2']);
    expect(progress.at(-1)).toEqual({ done: 2, total: 2, name: null });
    // Only the scope's document is in the .flextext.
    const xml = new TextDecoder().decode(files['Flex.flextext']);
    expect(xml).not.toContain('ba do');
  });

  it('warns and keeps going when an example document cannot be read', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo'), rawDoc('d2', 'Other', 'ba do')];
    const vocab = {
      ...VOCAB,
      items: [
        {
          id: 'i1',
          form: 'perro',
          metadata: { gloss: 'dog', examples: [{ document: 'd2', token: 'd2-w0' }] },
        },
      ],
    };
    const client = stubClient({ docs, vocab, failIds: ['d2'] });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'document', id: 'd1' },
    });
    const files = await unzipBlob(result.blob);
    expect(new TextDecoder().decode(files['Flex.lift'])).not.toContain('<example>');
    expect(result.warnings).toEqual([
      'Example document "Other" failed to load: boom',
      '1 example could not be read from the document it points into and was left out of the .lift file.',
    ]);
  });

  it('includes the lexicon for a preset saved before the option existed', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'Flex', 'hi yo')] });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    delete preset.options.lexicon;
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Flex-flex.zip');
    expect(Object.keys(await unzipBlob(result.blob))).toContain('Flex.lift');
  });

  it('exports the bare flextext when the lexicon is switched off', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    preset.options.lexicon = false;
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Flex.flextext');
    const dom = new DOMParser().parseFromString(await result.blob.text(), 'text/xml');
    expect(dom.querySelector('parsererror')).toBeNull();
    expect(dom.querySelectorAll('word').length).toBe(2);
    // The lexicon is still READ: the cf on every morph comes off the entry.
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toEqual([
      ['vocabLayers.get', 'v1'],
    ]);
  });

  it('reads no vocabulary at all when neither the lexicon nor cf is wanted', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    preset.options.lexicon = false;
    preset.options.citationForms = false;
    await runExport({ client, project: PROJECT, preset, scope: { type: 'document', id: 'd1' } });
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toEqual([]);
  });

  // Reported by a user: changing a preset, then exporting one document from
  // that same window, downloaded a file under the PROJECT's name. That window
  // has no "This document" radio, so a single document is chosen by checking
  // one under "Selected documents" — the same run, and it must be named the
  // same way.
  it('names a one-document selection after that document, not the project', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Beta', 'ba')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'documents', ids: ['d2'] },
    });
    expect(result.filename).toBe('Beta-flex.zip');
    expect(Object.keys(await unzipBlob(result.blob)).sort()).toEqual([
      'Beta.flextext',
      'Beta.lift',
      'README.txt',
    ]);
  });

  it('folds every document of a project into ONE flextext', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Beta', 'ba')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'project' },
    });
    expect(result.filename).toBe('My Project Test-flex.zip');
    const files = await unzipBlob(result.blob);
    const xml = new TextDecoder().decode(files['My Project Test.flextext']);
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    expect(dom.querySelector('parsererror')).toBeNull();
    expect(
      [...dom.querySelectorAll('interlinear-text > item[type="title"]')].map((t) => t.textContent),
    ).toEqual(['Alpha', 'Beta']);
  });

  it('fails a flextext export when a document cannot be read', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Beta', 'ba')];
    const client = stubClient({ docs, failIds: ['d2'] });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    preset.options.lexicon = false;
    await expect(
      runExport({ client, project: PROJECT, preset, scope: { type: 'project' } }),
    ).rejects.toThrow('"Beta" could not be read: boom');
  });

  it('fails rather than leave out a document that cannot be read', async () => {
    // A file with a document missing and nothing in it saying so reads as
    // the whole project. Every format, not only the archive.
    const docs = [rawDoc('d1', 'Good', 'hi'), rawDoc('d2', 'Bad', 'yo')];
    for (const preset of [
      plainPreset(),
      newPreset('plaid-igt-json', discoverExportLayers(PROJECT), 'n'),
    ]) {
      const client = stubClient({ docs, failIds: ['d2'] });
      await expect(
        runExport({ client, project: PROJECT, preset, scope: { type: 'project' } }),
      ).rejects.toThrow('"Bad" could not be read: boom');
    }
  });

  it('fails a selection whose document cannot be read, naming it', async () => {
    const docs = [rawDoc('d1', 'Bad', 'hi')];
    const client = stubClient({ docs, failIds: ['d1'] });
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: plainPreset(),
        scope: { type: 'documents', ids: ['d1'] },
      }),
    ).rejects.toThrow('"Bad" could not be read: boom');
  });

  it('honors cancellation between documents, and reads no further than the reads ahead', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => rawDoc(`d${i + 1}`, `T${i + 1}`, 'hi'));
    const client = stubClient({ docs });
    let fetched = 0;
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: plainPreset(),
        scope: { type: 'project' },
        onProgress: ({ name }) => {
          if (name) fetched++;
        },
        shouldStop: () => fetched >= 1,
      }),
    ).rejects.toThrow(ExportCancelled);
    // The first document, and the few read ahead of it before the cancel.
    const read = client.calls.filter(([m]) => m === 'documents.get').map(([, id]) => id);
    expect(read[0]).toBe('d1');
    expect(read.length).toBeLessThanOrEqual(1 + READS_IN_FLIGHT);
  });

  it('reads ahead but writes the documents and their progress in order', async () => {
    // The first read is the slowest, so the others land before it.
    const docs = ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => rawDoc(id, id.toUpperCase(), 'hi'));
    const client = stubClient({ docs, delays: { d1: 30, d2: 10 } });
    const progress = [];
    const result = await runExport({
      client,
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'project' },
      onProgress: (p) => progress.push(p),
    });
    const files = Object.keys(await unzipBlob(result.blob)).filter((f) =>
      f.startsWith('documents/'),
    );
    expect(files).toEqual([
      'documents/D1.txt',
      'documents/D2.txt',
      'documents/D3.txt',
      'documents/D4.txt',
      'documents/D5.txt',
    ]);
    expect(progress.filter((p) => p.name).map((p) => p.name)).toEqual([
      'D1',
      'D2',
      'D3',
      'D4',
      'D5',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('stops at the first document that cannot be read, in order, and reads no further ahead', async () => {
    const docs = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'].map((id) =>
      rawDoc(id, id.toUpperCase(), 'hi'),
    );
    const client = stubClient({ docs, failIds: ['d2', 'd4'], delays: { d1: 30 } });
    await expect(
      runExport({ client, project: PROJECT, preset: plainPreset(), scope: { type: 'project' } }),
    ).rejects.toThrow('"D2" could not be read');
    const read = client.calls.filter(([m]) => m === 'documents.get').map(([, id]) => id);
    expect(read.length).toBeLessThanOrEqual(2 + READS_IN_FLIGHT);
  });

  it("reads only this app's layers, except for the archive, which reads every layer", async () => {
    const project = {
      ...PROJECT,
      textLayers: [
        {
          id: 'tl',
          config: role('baseline'),
          tokenLayers: [
            { id: 'wl', config: role('word'), spanLayers: [] },
            {
              id: 'sl',
              config: role('sentence'),
              spanLayers: [
                { id: 'tr', config: { igt: { scope: 'Sentence' } } },
                { id: 'other', config: {} },
              ],
            },
            { id: 'ud', config: {}, spanLayers: [], overlapMode: 'any' },
          ],
        },
      ],
    };
    const docs = [rawDoc('d1', 'A', 'hi')];
    const plain = stubClient({ docs });
    await runExport({
      client: plain,
      project,
      preset: newPreset('plaintext', discoverExportLayers(project), 'p'),
      scope: { type: 'project' },
    });
    expect([...plain.readLayers.get('d1')].sort()).toEqual(['sl', 'tl', 'tr', 'wl']);
    const archive = stubClient({ docs });
    await runExport({
      client: archive,
      project,
      preset: newPreset('plaid-igt-json', discoverExportLayers(project), 'p'),
      scope: { type: 'project' },
    });
    expect(archive.readLayers.get('d1')).toBeNull();
  });

  it('includes vocabulary TSVs (the fields entries show, no Uses column)', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    const client = stubClient({ docs });
    const preset = { ...plainPreset(), includeVocabularies: true };
    const result = await runExport({
      client,
      project: PROJECT,
      preset,
      scope: { type: 'documents', ids: ['d1', 'd2'] },
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'documents/A.txt',
      'documents/B.txt',
      'vocabularies/Lexicon.tsv',
    ]);
    // gloss is listed, and morphType is a built-in field every entry shows.
    expect(new TextDecoder().decode(entries['vocabularies/Lexicon.tsv'])).toBe(
      'Form\tgloss\tmorphType\nperro\tdog\t\n',
    );
  });

  it('fails when a vocabulary it includes cannot be read, naming it', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    for (const preset of [
      { ...plainPreset(), includeVocabularies: true },
      newPreset('plaid-igt-json', discoverExportLayers(PROJECT), 'n'),
    ]) {
      const client = stubClient({ docs, vocabFails: true });
      await expect(
        runExport({ client, project: PROJECT, preset, scope: { type: 'project' } }),
      ).rejects.toThrow(/could not be read/);
    }
  });

  it('threads asOf into document fetches for historical export', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs });
    await runExport({
      client,
      project: PROJECT,
      preset: plainPreset(),
      scope: { type: 'document', id: 'd1' },
      asOf: '2026-01-01T00:00:00Z',
    });
    expect(client.calls).toEqual([['documents.get', 'd1', '2026-01-01T00:00:00Z']]);
  });
});

describe('runExport — native plaid-igt-json', () => {
  const nativePreset = (options = {}) => ({
    ...newPreset('plaid-igt-json', discoverExportLayers(PROJECT), 'n'),
    options: { includeMedia: true, ...options },
  });

  it('always zips — even at document scope — with manifest, doc, and vocab JSON', async () => {
    const docs = [rawDoc('d1', 'Solo', 'hi yo')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: { ...nativePreset(), includeVocabularies: false },
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo-export.zip');
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'documents/Solo.json',
      'project.json',
      'vocabularies/Lexicon.json',
    ]);
    const parsed = Object.fromEntries(
      Object.entries(entries).map(([path, bytes]) => [
        path,
        JSON.parse(new TextDecoder().decode(bytes)),
      ]),
    );
    expect(parsed['project.json'].formatVersion).toBe(1);
    expect(parsed['project.json'].documents).toEqual([
      { id: 'd1', name: 'Solo', file: 'documents/Solo.json', mediaFile: null },
    ]);
    expect(parsed['project.json'].vocabularies).toEqual([
      { id: 'v1', name: 'Lexicon', file: 'vocabularies/Lexicon.json' },
    ]);
    expect(parsed['documents/Solo.json'].baseline.body).toBe('hi yo');
    expect(parsed['documents/Solo.json'].sentences[0].words).toHaveLength(2);
    expect(parsed['vocabularies/Lexicon.json'].items).toEqual([
      { id: 'i1', form: 'perro', metadata: { gloss: 'dog' } },
    ]);
    // Vocabularies fetched despite includeVocabularies: false; no TSVs anywhere.
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toHaveLength(1);
    expect(Object.keys(entries).some((p) => p.endsWith('.tsv'))).toBe(false);
  });

  it('archives a project with no documents, since its lexicon is the content', async () => {
    const client = stubClient({ docs: [] });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['project.json', 'vocabularies/Lexicon.json']);
    const manifest = JSON.parse(new TextDecoder().decode(entries['project.json']));
    expect(manifest.documents).toEqual([]);
  });

  it('refuses an archive when a document asked for cannot be read', async () => {
    const docs = [rawDoc('d1', 'Bad', 'hi')];
    const client = stubClient({ docs, failIds: ['d1'] });
    await expect(
      runExport({ client, project: PROJECT, preset: nativePreset(), scope: { type: 'project' } }),
    ).rejects.toThrow('"Bad" could not be read');
  });

  it('embeds media via the injected fetcher, named by the fetched content type', async () => {
    // Server mediaUrls carry no filename — the extension must come from the fetch.
    const docs = [rawDoc('d1', 'A', 'hi', '/api/v1/documents/d1/media')];
    const client = stubClient({ docs });
    const fetched = [];
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
      fetchMedia: async (_c, url) => {
        fetched.push(url);
        return { bytes: new Uint8Array([9, 9]), ext: '.wav' };
      },
    });
    // Fetched by the document's own mediaUrl, which carries the file's version.
    expect(fetched).toEqual(['/api/v1/documents/d1/media']);
    const entries = await unzipBlob(result.blob);
    expect([...entries['media/A.wav']]).toEqual([9, 9]);
    const doc = JSON.parse(new TextDecoder().decode(entries['documents/A.json']));
    expect(doc.mediaFile).toBe('media/A.wav');
    const manifest = JSON.parse(new TextDecoder().decode(entries['project.json']));
    expect(manifest.documents[0].mediaFile).toBe('media/A.wav');
  });

  it('omits comments from a historical export, which has no state to read', async () => {
    // Comments are unaudited, so there is no `as-of` view of them. Exporting
    // today's would date them wrong and could anchor them to entities that did
    // not exist at `asOf`.
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({
      docs,
      users: { 'ada@x.com': 'Ada' },
      comments: {
        d1: [
          {
            id: 'c1',
            entityType: 'document',
            entityId: 'd1',
            authorId: 'ada@x.com',
            body: 'x',
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ],
      },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'document', id: 'd1' },
      asOf: '2026-01-01T00:00:00Z',
    });
    const entries = await unzipBlob(result.blob);
    const doc = JSON.parse(new TextDecoder().decode(entries['documents/A.json']));
    expect(doc).not.toHaveProperty('comments');
    expect(client.calls.some((c) => c[0].startsWith('comments.'))).toBe(false);
  });

  it('reads the vocabularies as they were at the time of a historical export', async () => {
    const then = {
      ...VOCAB,
      items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'hound' } }],
    };
    const client = stubClient({ docs: [rawDoc('d1', 'A', 'hi')], vocabThen: then });
    const at = '2026-01-01T00:00:00Z';
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'document', id: 'd1' },
      asOf: at,
    });
    expect(result.warnings).toEqual([]);
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toEqual([
      ['vocabLayers.get', 'v1', at],
    ]);
    const entries = await unzipBlob(result.blob);
    const lexicon = JSON.parse(new TextDecoder().decode(entries['vocabularies/Lexicon.json']));
    expect(lexicon.items.map((it) => it.metadata.gloss)).toEqual(['hound']);
  });

  it("carries the project's annotation manual", async () => {
    // Everything else a project says about itself was already in the archive.
    // The manual was the one piece the lossless archive silently dropped.
    const client = stubClient({
      docs: [rawDoc('d1', 'A', 'hi')],
      guidelines: [{ id: 'g1', title: 'Loanwords', body: 'Not segmented.', pinned: true }],
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'document', id: 'd1' },
    });
    const entries = await unzipBlob(result.blob);
    const manifest = JSON.parse(new TextDecoder().decode(entries['project.json']));
    expect(manifest.guidelines).toEqual([
      { title: 'Loanwords', body: 'Not segmented.', pinned: true },
    ]);
    // Bodies, not lengths: an archive that carried only the index would round
    // trip into a manual of empty headings.
    expect(client.calls.find((c) => c[0] === 'guidelines.list')[2]).toEqual({
      includeBodies: true,
    });
  });

  it('omits the manual from a historical export, which has no state to read', async () => {
    // Guidelines ARE audited, unlike comments, but `?as-of=` is
    // document-scoped, so there is no view of the manual as it was. Today's in
    // a time-travelled archive would be a claim about the past nobody made.
    const client = stubClient({
      docs: [rawDoc('d1', 'A', 'hi')],
      guidelines: [{ id: 'g1', title: 'Loanwords', body: 'Not segmented.', pinned: true }],
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'document', id: 'd1' },
      asOf: '2026-01-01T00:00:00Z',
    });
    const entries = await unzipBlob(result.blob);
    const manifest = JSON.parse(new TextDecoder().decode(entries['project.json']));
    expect(manifest.guidelines).toEqual([]);
    expect(client.calls.some((c) => c[0] === 'guidelines.list')).toBe(false);
  });

  it('fails an archive whose guidelines cannot be read', async () => {
    const client = stubClient({
      docs: [rawDoc('d1', 'A', 'hi')],
      guidelinesFail: true,
    });
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: nativePreset(),
        scope: { type: 'document', id: 'd1' },
      }),
    ).rejects.toThrow(/The guidelines could not be read/);
  });

  it("carries a document's comments, with author display names resolved", async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({
      docs,
      users: { 'ada@x.com': 'Ada Lovelace' },
      comments: {
        d1: [
          {
            id: 'c1',
            entityType: 'token',
            entityId: 'd1-w0',
            anchorLabel: 'Word hi, sentence 1',
            authorId: 'ada@x.com',
            body: 'Dative?',
            createdAt: '2026-08-14T09:31:07Z',
            updatedAt: '2026-08-14T09:31:07Z',
          },
        ],
      },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    const doc = JSON.parse(new TextDecoder().decode(entries['documents/A.json']));
    expect(doc.comments).toHaveLength(1);
    expect(doc.comments[0]).toMatchObject({
      id: 'c1',
      anchor: { type: 'token', id: 'd1-w0' },
      anchorLabel: 'Word hi, sentence 1',
      author: { id: 'ada@x.com', name: 'Ada Lovelace' },
      body: 'Dative?',
    });
    expect(result.warnings).toEqual([]);
  });

  it('resolves each author once across the whole export, not once per comment', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    const one = (id, entityId) => ({
      id,
      entityType: 'token',
      entityId,
      authorId: 'ada@x.com',
      body: 'x',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    });
    const client = stubClient({
      docs,
      users: { 'ada@x.com': 'Ada Lovelace' },
      comments: { d1: [one('c1', 'd1-w0'), one('c2', 'd1-s')], d2: [one('c3', 'd2-w0')] },
    });
    await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    expect(client.calls.filter((c) => c[0] === 'users.get')).toHaveLength(1);
  });

  it('falls back to no display name when the author cannot be looked up', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({
      docs,
      users: {},
      comments: {
        d1: [
          {
            id: 'c1',
            entityType: 'document',
            entityId: 'd1',
            authorId: 'ghost@x.com',
            body: 'x',
            createdAt: '2026-08-14T00:00:00Z',
            updatedAt: '2026-08-14T00:00:00Z',
          },
        ],
      },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    const doc = JSON.parse(new TextDecoder().decode(entries['documents/A.json']));
    expect(doc.comments[0].author).toEqual({ id: 'ghost@x.com', name: null });
    expect(result.warnings).toEqual([]);
  });

  it('drops comments the archive has no anchor for, counted once per document', async () => {
    // A relation belongs to another app's layer; a token that has since been
    // deleted is nowhere at all. Both are outlived by their comments.
    const docs = [rawDoc('d1', 'A', 'hi')];
    const one = (id, entityType, entityId) => ({
      id,
      entityType,
      entityId,
      authorId: 'ada@x.com',
      body: 'x',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    });
    const client = stubClient({
      docs,
      users: { 'ada@x.com': 'Ada' },
      comments: {
        d1: [
          one('c1', 'relation', 'r1'),
          one('c2', 'token', 'deleted'),
          one('c3', 'token', 'd1-w0'),
        ],
      },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    const doc = JSON.parse(new TextDecoder().decode(entries['documents/A.json']));
    expect(doc.comments.map((c) => c.id)).toEqual(['c3']);
    expect(result.warnings).toEqual([
      '"A": 2 comments not exported (what they are about is deleted, or belongs to another app)',
    ]);
  });

  it("carries a vocabulary's entry comments in its own file, dropping those on deleted entries", async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const one = (id, entityId) => ({
      id,
      entityType: 'vocab-item',
      entityId,
      anchorLabel: 'perro · dog',
      authorId: 'ada@x.com',
      body: 'Also a verb?',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    });
    const client = stubClient({
      docs,
      users: { 'ada@x.com': 'Ada Lovelace' },
      vocabComments: { v1: [one('c1', 'i1'), one('c2', 'gone')] },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    const vocab = JSON.parse(new TextDecoder().decode(entries['vocabularies/Lexicon.json']));
    expect(vocab.comments).toEqual([
      {
        id: 'c1',
        anchor: { type: 'vocab-item', id: 'i1' },
        anchorLabel: 'perro · dog',
        author: { id: 'ada@x.com', name: 'Ada Lovelace' },
        body: 'Also a verb?',
        createdAt: '2026-08-14T00:00:00Z',
        updatedAt: '2026-08-14T00:00:00Z',
      },
    ]);
    expect(result.warnings).toEqual(['"Lexicon": 1 comment on deleted entries not exported']);
    // One name lookup for the whole export, shared with the documents.
    expect(client.calls.filter((c) => c[0] === 'users.get')).toHaveLength(1);
  });

  it('fails an archive whose vocabulary comments cannot be read', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs, vocabCommentsFail: true });
    await expect(
      runExport({ client, project: PROJECT, preset: nativePreset(), scope: { type: 'project' } }),
    ).rejects.toThrow('The comments on "Lexicon" could not be read: vocab comment boom');
  });

  it('fails an archive whose document comments cannot be read', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs, commentsFail: true });
    await expect(
      runExport({ client, project: PROJECT, preset: nativePreset(), scope: { type: 'project' } }),
    ).rejects.toThrow('The comments on "A" could not be read: comment boom');
  });

  it('skips media when includeMedia is off', async () => {
    const docs = [rawDoc('d1', 'A', 'hi', '/media/d1/song.wav')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: nativePreset({ includeMedia: false }),
      scope: { type: 'project' },
      fetchMedia: async () => {
        throw new Error('should not be called');
      },
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).some((p) => p.startsWith('media/'))).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('fails when a recording it includes cannot be read', async () => {
    const docs = [rawDoc('d1', 'A', 'hi', '/media/d1/song.wav')];
    const client = stubClient({ docs });
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: nativePreset(),
        scope: { type: 'project' },
        fetchMedia: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('The recording of "A" could not be read: boom');
  });
});

describe('runExport — a read that fails for a moment', () => {
  const archive = () => ({
    ...newPreset('plaid-igt-json', discoverExportLayers(PROJECT), 'n'),
    options: { includeMedia: true },
  });
  const media = (failures) => {
    let n = failures;
    return async () => {
      if (n > 0) {
        n -= 1;
        throw Object.assign(new Error('media fetch failed (502)'), { status: 502 });
      }
      return { bytes: new Uint8Array([1]), ext: '.wav', mime: 'audio/wav' };
    };
  };
  const RETRY = { retryDelaysMs: [0, 0, 0] };

  it('reads it again and finishes, for every read the archive makes', async () => {
    const docs = [rawDoc('d1', 'A', 'hi', '/media/d1/song.wav')];
    const client = stubClient({
      docs,
      flaky: {
        'documents.get': 2,
        'comments.list': 1,
        'guidelines.list': 1,
        'vocabLayers.get': 2,
        'comments.listInVocab': 1,
      },
    });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: archive(),
      scope: { type: 'project' },
      fetchMedia: media(2),
      ...RETRY,
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries)).toContain('documents/A.json');
    expect(Object.keys(entries).some((p) => p.startsWith('media/'))).toBe(true);
    expect(Object.keys(entries)).toContain('vocabularies/Lexicon.json');
    expect(result.warnings).toEqual([]);
  });

  it('fails once the retries are spent, after four reads', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs, flaky: { 'documents.get': 9 } });
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: plainPreset(),
        scope: { type: 'project' },
        ...RETRY,
      }),
    ).rejects.toThrow('"A" could not be read');
    expect(client.calls.filter(([m]) => m === 'documents.get')).toHaveLength(4);
  });

  it('does not read again after an error that is not passing', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs, failIds: ['d1'] });
    await expect(
      runExport({
        client,
        project: PROJECT,
        preset: plainPreset(),
        scope: { type: 'project' },
        ...RETRY,
      }),
    ).rejects.toThrow('"A" could not be read: boom');
    expect(client.calls.filter(([m]) => m === 'documents.get')).toHaveLength(1);
  });
});

describe('runExport — CLDF', () => {
  const LANGUAGED_PROJECT = {
    ...PROJECT,
    config: {
      igt: {
        languages: {
          object: { name: 'Spanish', glottocode: 'stan1288', iso639P3: 'spa' },
          meta: { name: 'English', iso639P3: 'eng' },
        },
      },
    },
  };
  const cldfPreset = (options = {}) => {
    const p = newPreset('cldf', discoverExportLayers(LANGUAGED_PROJECT), 'c');
    return { ...p, options: { ...p.options, ...options } };
  };
  const text = (entries, path) => new TextDecoder().decode(entries[path]);

  it('always zips one dataset, folding every document into examples.csv', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Beta', 'ba')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: cldfPreset(),
      scope: { type: 'project' },
    });
    expect(result.filename).toBe('My Project Test-cldf.zip');
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'cldf-metadata.json',
      'contributions.csv',
      'entries.csv',
      'examples.csv',
      'languages.csv',
      'senses.csv',
    ]);
    const examples = text(entries, 'examples.csv').trim().split('\r\n');
    expect(examples).toHaveLength(3);
    expect(examples[1]).toContain('hi\tyo');
    expect(examples[2]).toContain('ba');
    expect(text(entries, 'contributions.csv')).toContain('Alpha');
    expect(text(entries, 'contributions.csv')).toContain('Beta');
  });

  it('refuses two vocabularies with one name, which a dataset cannot tell apart', async () => {
    const docs = [rawDoc('d1', 'Solo', 'hi')];
    const client = stubClient({ docs });
    client.vocabLayers.get = async (id) => ({ ...VOCAB, id });
    await expect(
      runExport({
        client,
        project: { ...LANGUAGED_PROJECT, vocabs: [{ id: 'v1' }, { id: 'v2' }] },
        preset: cldfPreset(),
        scope: { type: 'project' },
      }),
    ).rejects.toThrow(/Two vocabularies are named "Lexicon"/);
  });

  it('zips even at document scope, since a dataset is many files', async () => {
    const docs = [rawDoc('d1', 'Solo', 'hi')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: cldfPreset(),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo-cldf.zip');
    expect(Object.keys(await unzipBlob(result.blob))).toContain('cldf-metadata.json');
  });

  it('reads the language identity from project config', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'A', 'hi')] });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: cldfPreset(),
      scope: { type: 'project' },
    });
    const entries = await unzipBlob(result.blob);
    expect(text(entries, 'languages.csv')).toContain('stan1288,Spanish,stan1288,spa');
    expect(result.warnings).toEqual([]);
  });

  it('warns when the project has no language identity configured', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'A', 'hi')] });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: cldfPreset(),
      scope: { type: 'project' },
    });
    expect(result.warnings.join(' ')).toMatch(/no Glottocode or ISO 639-3/);
  });

  it('loads vocabularies for the dictionary even without includeVocabularies', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'A', 'hi')] });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: { ...cldfPreset(), includeVocabularies: false },
      scope: { type: 'project' },
    });
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toHaveLength(1);
    const entries = await unzipBlob(result.blob);
    expect(text(entries, 'entries.csv')).toContain('perro');
    expect(text(entries, 'senses.csv')).toContain('dog');
    // No TSV fallback: the vocabularies became CLDF tables instead.
    expect(Object.keys(entries).some((p) => p.endsWith('.tsv'))).toBe(false);
  });

  it('skips the vocabulary fetch when the dictionary option is off', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'A', 'hi')] });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: cldfPreset({ dictionary: false }),
      scope: { type: 'project' },
    });
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toHaveLength(0);
    expect(Object.keys(await unzipBlob(result.blob))).not.toContain('entries.csv');
  });

  it('embeds media and records its type in the MediaTable', async () => {
    const docs = [rawDoc('d1', 'A', 'hi', '/media/d1')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: LANGUAGED_PROJECT,
      preset: cldfPreset(),
      scope: { type: 'project' },
      fetchMedia: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        ext: '.wav',
        mime: 'audio/vnd.wave',
      }),
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries)).toContain('media/A.wav');
    expect(text(entries, 'media.csv')).toContain('audio/vnd.wave,media/A.wav,1');
  });
});

describe('runExport — elan .eaf', () => {
  const elanPreset = (options = {}) => {
    const preset = newPreset('elan', discoverExportLayers(PROJECT), 'e');
    return { ...preset, options: { ...preset.options, ...options } };
  };
  const parseXml = (xml) => {
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    expect(dom.querySelector('parsererror')).toBeNull();
    return dom;
  };
  const tagged = (dom, tag) => [...dom.getElementsByTagName(tag)];

  it('exports a single medialess document as a bare .eaf', async () => {
    const docs = [rawDoc('d1', 'Solo Doc', 'hi yo')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: elanPreset(),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo Doc.eaf');
    expect(result.blob.type).toBe('text/xml;charset=utf-8');
    const dom = parseXml(await result.blob.text());
    expect(dom.documentElement.getAttribute('VERSION')).toBe('2.8');
    expect(tagged(dom, 'ANNOTATION_VALUE').map((n) => n.textContent)).toEqual([
      'hi yo',
      'hi',
      'yo',
    ]);
    expect(tagged(dom, 'MEDIA_DESCRIPTOR')).toHaveLength(0);
  });

  it('bundles a lone .eaf with its media so the relative link resolves', async () => {
    const docs = [rawDoc('d1', 'A', 'hi yo', '/media/d1')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: elanPreset(),
      scope: { type: 'document', id: 'd1' },
      fetchMedia: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        ext: '.wav',
        mime: 'audio/vnd.wave',
      }),
    });
    expect(result.filename).toBe('A-export.zip');
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['documents/A.eaf', 'media/A.wav']);
    const media = tagged(
      parseXml(new TextDecoder().decode(entries['documents/A.eaf'])),
      'MEDIA_DESCRIPTOR',
    )[0];
    expect(media.getAttribute('RELATIVE_MEDIA_URL')).toBe('../media/A.wav');
    expect(media.getAttribute('MIME_TYPE')).toBe('audio/vnd.wave');
  });

  it('names the recording from its Media file field, with the stored extension', async () => {
    const doc = {
      ...rawDoc('d1', 'A', 'hi yo', '/media/d1'),
      metadata: { 'Media file': 'oni-ah.mp4' },
    };
    const client = stubClient({ docs: [doc] });
    const result = await runExport({
      client,
      project: { ...PROJECT, config: { igt: { documentMetadata: [{ name: 'Media file' }] } } },
      preset: elanPreset(),
      scope: { type: 'document', id: 'd1' },
      fetchMedia: async () => ({ bytes: new Uint8Array([1]), ext: '.mp3', mime: 'audio/mpeg' }),
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['documents/A.eaf', 'media/oni-ah.mp3']);
    const dom = parseXml(new TextDecoder().decode(entries['documents/A.eaf']));
    expect(tagged(dom, 'MEDIA_DESCRIPTOR')[0].getAttribute('MEDIA_URL')).toBe('oni-ah.mp3');
    // The field is the recording's name, which the descriptor already says.
    expect(tagged(dom, 'PROPERTY').map((p) => p.getAttribute('NAME'))).toEqual(['documentName']);
  });

  it('stays a bare file when media is switched off', async () => {
    const docs = [rawDoc('d1', 'A', 'hi', '/media/d1/song.wav')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: elanPreset({ includeMedia: false }),
      scope: { type: 'document', id: 'd1' },
      fetchMedia: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(result.filename).toBe('A.eaf');
    // The document still declares its media, by the name it will be saved under.
    const media = tagged(parseXml(await result.blob.text()), 'MEDIA_DESCRIPTOR')[0];
    expect(media.getAttribute('RELATIVE_MEDIA_URL')).toBe('./song.wav');
  });

  it('exports a project as a zip of one .eaf per document', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Beta', 'ba')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: elanPreset(),
      scope: { type: 'project' },
    });
    expect(result.filename).toBe('My Project Test-export.zip');
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['documents/Alpha.eaf', 'documents/Beta.eaf']);
  });
});

describe('runExport: LaTeX book', () => {
  const latexPreset = () => newPreset('latex', discoverExportLayers(PROJECT), 'l');
  const text = (entries, path) => new TextDecoder().decode(entries[path]);

  it('zips a book with a chapter per document, included in the order of the run', async () => {
    const docs = [rawDoc('d1', 'Alpha', 'hi yo'), rawDoc('d2', 'Alpha', 'ba')];
    const client = stubClient({ docs });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: latexPreset(),
      scope: { type: 'project' },
    });
    expect(result.filename).toBe('My Project Test-latex.zip');
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'README.txt',
      'abbreviations.tex',
      'latexmkrc',
      'main.tex',
      'texts/001-alpha.tex',
      'texts/002-alpha.tex',
    ]);
    const main = text(entries, 'main.tex');
    expect(main).toContain('\\title{My Project: Test}');
    expect(main.indexOf('\\include{texts/001-alpha}')).toBeLessThan(
      main.indexOf('\\include{texts/002-alpha}'),
    );
    expect(text(entries, 'texts/001-alpha.tex')).toContain(
      '\\gla \\PlaidWord{hi} \\PlaidWord{yo} //',
    );
    // No vocabulary is read: the book has no place for one.
    expect(client.calls.some((c) => c[0] === 'vocabLayers.get')).toBe(false);
  });

  it('zips even at document scope, titled after the document', async () => {
    const client = stubClient({ docs: [rawDoc('d1', 'Solo', 'hi')] });
    const result = await runExport({
      client,
      project: PROJECT,
      preset: latexPreset(),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo-latex.zip');
    const entries = await unzipBlob(result.blob);
    expect(text(entries, 'main.tex')).toContain('\\title{Solo}');
    expect(text(entries, 'texts/001-solo.tex')).toContain('\\chapter{Solo}');
  });
});
