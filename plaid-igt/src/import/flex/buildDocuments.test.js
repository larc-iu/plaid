// Alignment tests against the real sample backups (skipped when absent).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { cpSlice, cpLength } from '@larc-iu/plaid-client';
import { readFwbackup } from './fwbackup.js';
import { parseFwdata } from './fwdataParser.js';
import { buildDocuments } from './buildDocuments.js';

const LEZGI = '/home/luke/local/plaid/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';
const SENA = '/home/luke/Downloads/Sena 3 2018-09-11 1145.fwbackup';

const load = (path) => buildDocuments(parseFwdata(readFwbackup(new Uint8Array(readFileSync(path))).xml));

function expectInvariants(doc) {
  // Sentences tile the body exactly (partitioning layer requirement).
  const len = cpLength(doc.body);
  if (doc.body.length === 0) return;
  expect(doc.sentences.length).toBeGreaterThan(0);
  expect(doc.sentences[0].begin).toBe(0);
  expect(doc.sentences[doc.sentences.length - 1].end).toBe(len);
  for (let i = 1; i < doc.sentences.length; i += 1) {
    expect(doc.sentences[i].begin).toBe(doc.sentences[i - 1].end);
  }
  // Words are in order, non-overlapping, within bounds, and match the surface.
  let prev = 0;
  for (const w of doc.words) {
    expect(w.begin).toBeGreaterThanOrEqual(prev);
    expect(w.end).toBeGreaterThan(w.begin);
    expect(w.end).toBeLessThanOrEqual(len);
    prev = w.end;
  }
}

describe.skipIf(!existsSync(LEZGI))('buildDocuments — Lezgi sample', () => {
  let result;
  beforeAll(() => { result = load(LEZGI); });

  it('builds 21 documents with 1200 sentences', () => {
    expect(result.stats.documents).toBe(21);
    expect(result.stats.sentences).toBeGreaterThanOrEqual(1200);
  });

  it('aligns every word to the surface with no warnings', () => {
    expect(result.stats.words).toBe(10594);
    expect(result.stats.unalignedWords).toBe(0);
    expect(result.stats.warnings).toBe(0);
  });

  it('satisfies partitioning + ordering invariants in every document', () => {
    for (const doc of result.documents) expectInvariants(doc);
  });

  it('word spans reproduce the surface forms (case-insensitively)', () => {
    for (const doc of result.documents) {
      for (const w of doc.words) {
        const surface = cpSlice(doc.body, w.begin, w.end);
        const form = w.forms[result.baselineWs] ?? Object.values(w.forms)[0];
        expect(surface.toLowerCase()).toBe(form.toLowerCase());
      }
    }
  });

  it('aligns the Sea Princess first sentence exactly', () => {
    const doc = result.documents.find((d) => d.names?.en === 'The Sea Princess');
    expect(doc.body.startsWith('За квез са хъсан са мах ахъайин гьуьлуьн рушакай.')).toBe(true);
    const s0words = doc.words.filter((w) => w.begin < doc.sentences[0].end);
    expect(s0words.map((w) => cpSlice(doc.body, w.begin, w.end))).toEqual(
      ['За', 'квез', 'са', 'хъсан', 'са', 'мах', 'ахъайин', 'гьуьлуьн', 'рушакай']);
    expect(s0words[0].gloss.en).toBe('I-ERG');
    expect(doc.sentences[0].freeTranslation.en).toMatch(/Sea Princess/);
  });

  it('finds the transliteration orthography', () => {
    expect(result.baselineWs).toBe('lez-Cyrl-AZ-x-qusar');
    expect(result.orthographyWss).toEqual(['lez-Qaaa-AZ-x-Tran-lat']);
  });

  it('keeps morphemes with lexicon links on aligned words', () => {
    expect(result.stats.morphemes).toBe(15724);
    const withSense = result.documents.flatMap((d) => d.words)
      .flatMap((w) => w.morphemes ?? []).filter((m) => m.senseGuid);
    expect(withSense.length).toBeGreaterThan(10000);
  });
});

describe.skipIf(!existsSync(SENA))('buildDocuments — Sena 3 sample', () => {
  let result;
  beforeAll(() => { result = load(SENA); });

  it('aligns the corpus completely', () => {
    expect(result.stats.documents).toBe(4);
    expect(result.stats.words).toBe(150);
    expect(result.stats.unalignedWords).toBe(0);
    expect(result.stats.warnings).toBe(0);
  });

  it('satisfies invariants in every document', () => {
    for (const doc of result.documents) expectInvariants(doc);
  });
});
