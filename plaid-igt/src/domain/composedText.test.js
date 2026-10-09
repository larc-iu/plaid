// Text read from a file or typed is sent composed (NFC), as the server stores
// it, and every token measured on it is measured on the composed text.
import { beforeEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc, resetIds } from './test-helpers.js';
import { digestOf, segmentServer } from '../test/segmentServer.js';
import { parseCsv } from '../import/cldf/readDataset.js';
import { readEaf } from '../import/elan/readEaf.js';
import { readNativeArchive } from '../import/native/readArchive.js';

beforeEach(() => resetIds());

const A = 'a\u0301'; // á typed as a and a combining acute

describe('the Baseline tab', () => {
  const tokenized = (body) =>
    buildRawDoc({
      body,
      words: [...body.matchAll(/\S+/gu)].map((m, i) => ({
        id: `w-${i + 1}`,
        begin: [...body.slice(0, m.index)].length,
        end: [...body.slice(0, m.index)].length + [...m[0]].length,
      })),
      morphemes: [],
    });

  it('measures the words of a new sentence on the text composed', async () => {
    const server = segmentServer(tokenized('uno dos'));
    const doc = new IgtDocument({
      raw: structuredClone(server.stored),
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: {},
      client: server.client,
      projectId: 'proj-1',
      user: { id: 'a' },
    });
    doc._writes._retryDelay = () => 5;
    const gaps = [{ start: 7, end: 7, value: `. tr${A}s c${A}` }];
    await doc.editBaselineText({ base: 'uno dos', digest: digestOf('uno dos'), gaps });
    const [edit, words] = server.sent[0].ops;
    expect(edit.kind).toBe('texts.edit');
    const composed = [...'uno dos. trás cá'];
    expect(words.args[0].map((w) => composed.slice(w.begin, w.end).join(''))).toEqual([
      'trás',
      'cá',
    ]);
  });
});

describe('a character a token edge keeps decomposed', () => {
  // "ka", its tone mark as a word of its own, "ma": the server keeps the
  // mark apart from the a, so each word keeps its own letters
  const KEPT = 'ka\u0301 ma';

  it('a new word is measured on the body the server keeps', async () => {
    const raw = buildRawDoc({
      body: KEPT,
      words: [
        { id: 'w-1', begin: 0, end: 2 },
        { id: 'w-2', begin: 2, end: 3 },
        { id: 'w-3', begin: 4, end: 6 },
      ],
      morphemes: [],
    });
    const server = segmentServer(raw);
    const doc = new IgtDocument({
      raw: structuredClone(server.stored),
      project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
      vocabularies: {},
      client: server.client,
      projectId: 'proj-1',
      user: { id: 'a' },
    });
    doc._writes._retryDelay = () => 5;
    const gaps = [{ start: 6, end: 6, value: ' tres' }];
    await doc.editBaselineText({ base: KEPT, digest: digestOf(KEPT), gaps });
    const [edit, words] = server.sent[0].ops;
    expect(edit.kind).toBe('texts.edit');
    expect(words.args[0].map((w) => [w.begin, w.end])).toEqual([[7, 11]]);
  });

  it('a native archive keeps it, with its offsets', () => {
    const enc = new TextEncoder();
    const doc = {
      id: 'd1',
      name: 'D',
      baseline: { body: `${KEPT} b${A}` },
      sentences: [
        {
          begin: 0,
          end: 10,
          words: [
            { begin: 0, end: 2, text: 'ka' },
            { begin: 2, end: 3, text: '\u0301' },
            { begin: 4, end: 6, text: 'ma' },
            { begin: 7, end: 10, text: `b${A}` },
          ],
        },
      ],
    };
    const manifest = {
      format: 'plaid-igt',
      formatVersion: 1,
      vocabularies: [],
      documents: [{ id: 'd1', name: 'D', file: 'documents/A.json' }],
    };
    const bytes = zipSync({
      'project.json': enc.encode(JSON.stringify(manifest)),
      'documents/A.json': enc.encode(JSON.stringify(doc)),
    });
    const { data } = readNativeArchive(bytes).documents[0];
    expect(data.baseline.body).toBe('ka\u0301 ma b\u00e1');
    expect(data.sentences[0].words.map((w) => [w.begin, w.end])).toEqual([
      [0, 2],
      [2, 3],
      [4, 6],
      [7, 9],
    ]);
  });
});

describe('importers read text composed', () => {
  it('a CSV cell', () => {
    expect(parseCsv(`Form\np${A}`)).toEqual([['Form'], ['pá']]);
  });

  it('an ELAN annotation', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT><HEADER/><TIME_ORDER/>
<TIER TIER_ID="T" LINGUISTIC_TYPE_REF="u"><ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a1">
<ANNOTATION_VALUE>p${A}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION></TIER>
<LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="u" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>`;
    expect(readEaf(xml, 'x.eaf').tiers[0].annotations[0].value).toBe('pá');
  });

  it('a native archive, with its offsets moved onto the composed body', () => {
    const enc = new TextEncoder();
    const doc = {
      id: 'd1',
      name: `D${A}`,
      baseline: { body: `p${A} b${A}` },
      sentences: [
        {
          begin: 0,
          end: 7,
          words: [
            { begin: 0, end: 3, text: `p${A}`, metadata: { begin: 4, end: 7 } },
            { begin: 4, end: 7, text: `b${A}` },
          ],
        },
      ],
    };
    const manifest = {
      format: 'plaid-igt',
      formatVersion: 1,
      vocabularies: [],
      documents: [{ id: 'd1', name: `D${A}`, file: 'documents/A.json' }],
    };
    const bytes = zipSync({
      'project.json': enc.encode(JSON.stringify(manifest)),
      'documents/A.json': enc.encode(JSON.stringify(doc)),
    });
    const { data } = readNativeArchive(bytes).documents[0];
    expect(data.name).toBe('Dá');
    expect(data.baseline.body).toBe('pá bá');
    expect(data.sentences[0]).toMatchObject({ begin: 0, end: 5 });
    expect(data.sentences[0].words).toEqual([
      { begin: 0, end: 2, text: 'pá', metadata: { begin: 4, end: 7 } },
      { begin: 3, end: 5, text: 'bá' },
    ]);
  });
});
