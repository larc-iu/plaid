import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { runExport, ExportCancelled } from './runExport.js';
import { discoverExportLayers } from './exportLayers.js';
import { newPreset } from './presets.js';

// ---- minimal raw IGT document + project fixtures ---------------------------

const role = (r) => ({ plaid: { role: r } });

// One sentence covering the whole body, one word token per space-separated run.
function rawDoc(id, name, body) {
  const words = [];
  let begin = 0;
  for (const w of body.split(' ')) {
    words.push({ id: `${id}-w${begin}`, begin, end: begin + [...w].length });
    begin += [...w].length + 1;
  }
  return {
    id, name,
    textLayers: [{
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
    }],
  };
}

const PROJECT = {
  id: 'p1', name: 'My Project: Test',
  textLayers: [{
    config: role('baseline'),
    tokenLayers: [
      { config: role('word'), spanLayers: [] },
      { config: role('sentence'), spanLayers: [] },
    ],
  }],
  vocabs: [{ id: 'v1' }],
};

const VOCAB = {
  id: 'v1', name: 'Lexicon',
  config: { igt: { fields: { gloss: { inline: true }, form: { inline: true } } } },
  items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog' } }],
  vocabLinks: [],
};

function stubClient({ docs, failIds = [], vocabFails = false }) {
  const calls = [];
  return {
    calls,
    projects: {
      listDocuments: async (id) => {
        calls.push(['listDocuments', id]);
        return docs.map((d) => ({ id: d.id, name: d.name }));
      },
    },
    documents: {
      get: async (id, full, asOf) => {
        calls.push(asOf ? ['documents.get', id, asOf] : ['documents.get', id]);
        if (failIds.includes(id)) throw new Error('boom');
        return JSON.parse(JSON.stringify(docs.find((d) => d.id === id)));
      },
    },
    vocabLayers: {
      get: async (id) => {
        calls.push(['vocabLayers.get', id]);
        if (vocabFails) throw new Error('vocab boom');
        return JSON.parse(JSON.stringify(VOCAB));
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
      client, project: PROJECT, preset: plainPreset(),
      scope: { type: 'project' }, onProgress: (p) => progress.push(p),
    });
    expect(result.filename).toBe('My Project Test-export.zip');
    expect(result.warnings).toEqual([]);
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual(['documents/Alpha (2).txt', 'documents/Alpha.txt']);
    expect(new TextDecoder().decode(entries['documents/Alpha.txt'])).toContain('hi  yo');
    // Sequential fetch order, after a single listDocuments.
    expect(client.calls).toEqual([
      ['listDocuments', 'p1'], ['documents.get', 'd1'], ['documents.get', 'd2'],
    ]);
    expect(progress.at(-1)).toEqual({ done: 2, total: 2, name: null });
  });

  it('exports a single document as a bare file without listing', async () => {
    const docs = [rawDoc('d1', 'Solo Doc', 'hi')];
    const client = stubClient({ docs });
    const result = await runExport({
      client, project: PROJECT, preset: plainPreset(),
      scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Solo Doc.txt');
    expect(await result.blob.text()).toContain('Solo Doc');
    expect(client.calls).toEqual([['documents.get', 'd1']]);
  });

  it('produces well-formed flextext without fetching vocabularies', async () => {
    const docs = [rawDoc('d1', 'Flex', 'hi yo')];
    const client = stubClient({ docs });
    const preset = newPreset('flextext', discoverExportLayers(PROJECT), 'f');
    const result = await runExport({
      client, project: PROJECT, preset, scope: { type: 'document', id: 'd1' },
    });
    expect(result.filename).toBe('Flex.flextext');
    const xml = await result.blob.text();
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    expect(dom.querySelector('parsererror')).toBeNull();
    expect(dom.querySelectorAll('word').length).toBe(2);
    expect(client.calls.filter(([m]) => m === 'vocabLayers.get')).toEqual([]);
  });

  it('turns per-document failures into warnings, not aborts', async () => {
    const docs = [rawDoc('d1', 'Good', 'hi'), rawDoc('d2', 'Bad', 'yo')];
    const client = stubClient({ docs, failIds: ['d2'] });
    const result = await runExport({
      client, project: PROJECT, preset: plainPreset(), scope: { type: 'project' },
    });
    expect(result.warnings).toEqual(['Document d2 failed to load: boom']);
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries)).toEqual(['documents/Good.txt']);
  });

  it('throws when nothing could be exported', async () => {
    const docs = [rawDoc('d1', 'Bad', 'hi')];
    const client = stubClient({ docs, failIds: ['d1'] });
    await expect(runExport({
      client, project: PROJECT, preset: plainPreset(), scope: { type: 'project' },
    })).rejects.toThrow(/Nothing exported/);
  });

  it('honors cancellation between documents', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    const client = stubClient({ docs });
    let fetched = 0;
    await expect(runExport({
      client, project: PROJECT, preset: plainPreset(), scope: { type: 'project' },
      onProgress: ({ name }) => { if (name) fetched++; },
      shouldStop: () => fetched >= 1,
    })).rejects.toThrow(ExportCancelled);
    expect(client.calls.filter(([m]) => m === 'documents.get')).toEqual([['documents.get', 'd1']]);
  });

  it('includes vocabulary TSVs (fields from config, no Uses column)', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    const client = stubClient({ docs });
    const preset = { ...plainPreset(), includeVocabularies: true };
    const result = await runExport({
      client, project: PROJECT, preset, scope: { type: 'documents', ids: ['d1', 'd2'] },
    });
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).sort()).toEqual([
      'documents/A.txt', 'documents/B.txt', 'vocabularies/Lexicon.tsv',
    ]);
    expect(new TextDecoder().decode(entries['vocabularies/Lexicon.tsv']))
      .toBe('Form\tgloss\nperro\tdog\n');
  });

  it('warns about failed vocabularies without emitting empty TSVs for them', async () => {
    const docs = [rawDoc('d1', 'A', 'hi'), rawDoc('d2', 'B', 'yo')];
    const client = stubClient({ docs, vocabFails: true });
    const preset = { ...plainPreset(), includeVocabularies: true };
    const result = await runExport({
      client, project: PROJECT, preset, scope: { type: 'project' },
    });
    expect(result.warnings).toEqual(['1 vocabulary failed to load']);
    const entries = await unzipBlob(result.blob);
    expect(Object.keys(entries).some((p) => p.startsWith('vocabularies/'))).toBe(false);
  });

  it('threads asOf into document fetches for historical export', async () => {
    const docs = [rawDoc('d1', 'A', 'hi')];
    const client = stubClient({ docs });
    await runExport({
      client, project: PROJECT, preset: plainPreset(),
      scope: { type: 'document', id: 'd1' }, asOf: '2026-01-01T00:00:00Z',
    });
    expect(client.calls).toEqual([['documents.get', 'd1', '2026-01-01T00:00:00Z']]);
  });
});
