// Parser tests against the real sample backups. The samples are large local
// files outside the repo, so every suite is skipped when they're absent
// (CI won't have them) — same convention as the bugbash harness.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { readFwbackup } from './fwbackup.js';
import { parseFwdata, pickEn } from './fwdataParser.js';

const LEZGI = '/home/luke/local/plaid/Lezgi-Qusar dialect 2019-12-12 0934 change_comps.fwbackup';
const SENA = '/home/luke/Downloads/Sena 3 2018-09-11 1145.fwbackup';

const load = (path) => {
  const { name, xml } = readFwbackup(new Uint8Array(readFileSync(path)));
  return { name, ir: parseFwdata(xml) };
};

describe.skipIf(!existsSync(LEZGI))('parseFwdata — Lezgi sample', () => {
  let name, ir;
  beforeAll(() => ({ name, ir } = load(LEZGI)));

  it('identifies the project and format version', () => {
    expect(name).toBe('Lezgi-Qusar dialect');
    expect(ir.version).toBe('7000070');
  });

  it('finds the writing systems', () => {
    expect(ir.writingSystems.vernacular).toEqual(['lez-Cyrl-AZ-x-qusar', 'lez-Qaaa-AZ-x-Tran-lat']);
    expect(ir.writingSystems.analysis[0]).toBe('en');
  });

  it('extracts all 21 texts with 1200 segments total', () => {
    expect(ir.texts).toHaveLength(21);
    const segs = ir.texts.flatMap((t) => t.paragraphs.flatMap((p) => p.segments));
    expect(segs).toHaveLength(1200);
  });

  it('extracts the Sea Princess first sentence faithfully', () => {
    const t = ir.texts.find((x) => x.names?.en === 'The Sea Princess');
    expect(t).toBeDefined();
    expect(t.names['lez-Cyrl-AZ-x-qusar']).toBe('07 Гьуьлун рушакайни');
    expect(t.source?.en).toMatch(/Rosa/);
    const p = t.paragraphs[0];
    expect(p.content).toBe('За квез са хъсан са мах ахъайин гьуьлуьн рушакай. ');
    const s = p.segments[0];
    expect(s.beginOffset).toBe(0);
    expect(s.freeTranslation.en).toMatch(/Sea Princess/);
    // 9 words + final period
    const words = s.analyses.filter((a) => a.kind === 'word');
    const puncts = s.analyses.filter((a) => a.kind === 'punct');
    expect(words).toHaveLength(9);
    expect(puncts.map((x) => x.form)).toEqual(['.']);
    // first word: за "I-ERG", pronoun, one morpheme linked to the lexicon
    const w = words[0];
    expect(w.forms['lez-Cyrl-AZ-x-qusar']).toBe('за');
    expect(w.forms['lez-Qaaa-AZ-x-Tran-lat']).toBe('za');
    expect(w.gloss.en).toBe('I-ERG');
    expect(w.morphemes).toHaveLength(1);
    expect(w.morphemes[0].gloss.en).toBe('1sg-ERG');
    expect(w.morphemes[0].morphType).toBe('stem');
    expect(w.morphemes[0].entryGuid).toBe('124a092a-2d42-4162-b16f-1c7d99e5e717');
    expect(w.morphemes[0].senseGuid).toBe('0896fce4-959a-4cec-966a-b4b099c38825');
  });

  it('counts word/punct instances as audited', () => {
    const items = ir.texts.flatMap((t) =>
      t.paragraphs.flatMap((p) => p.segments.flatMap((s) => s.analyses)));
    expect(items.filter((a) => a.kind === 'word')).toHaveLength(10594);
    expect(items.filter((a) => a.kind === 'punct')).toHaveLength(3376);
    const bundles = items.flatMap((a) => a.morphemes ?? []);
    expect(bundles).toHaveLength(15724);
  });

  it('extracts the full lexicon with senses', () => {
    expect(ir.lexicon).toHaveLength(4117);
    const senses = ir.lexicon.flatMap((e) => e.senses);
    expect(senses.length).toBeGreaterThanOrEqual(4590 - 10); // few orphans tolerated
    const za = ir.lexicon.find((e) => e.guid === '124a092a-2d42-4162-b16f-1c7d99e5e717');
    expect(za.forms['lez-Cyrl-AZ-x-qusar']).toBe('за');
    expect(za.morphType).toBe('stem');
    expect(za.senses[0].gloss.en).toBe('1sg-ERG');
  });

  it('tracks ws usage for field planning', () => {
    expect(ir.wsUsage.wordGloss).toContain('en');
    expect(ir.wsUsage.morphGloss).toContain('en');
    expect(ir.wsUsage.freeTranslation).toContain('en');
    expect(ir.wsUsage.wordForms).toEqual(
      expect.arrayContaining(['lez-Cyrl-AZ-x-qusar', 'lez-Qaaa-AZ-x-Tran-lat']));
  });

  it('produces NFC output', () => {
    for (const t of ir.texts) {
      for (const p of t.paragraphs) {
        expect(p.content === p.content.normalize('NFC')).toBe(true);
      }
    }
  });
});

describe.skipIf(!existsSync(SENA))('parseFwdata — Sena 3 sample (newer format)', () => {
  let ir;
  beforeAll(() => ({ ir } = load(SENA)));

  it('parses the newer 7000072 format', () => {
    expect(ir.version).toBe('7000072');
    expect(ir.texts.length).toBeGreaterThan(0);
    expect(ir.lexicon.length).toBeGreaterThan(0);
  });

  it('surfaces custom field definitions', () => {
    expect(ir.customFields.length).toBeGreaterThan(0);
    expect(ir.customFields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Plural', 'Singular', 'Parsing Note']));
  });

  it('extracts custom field VALUES on entries and senses', () => {
    const withPlural = ir.lexicon.filter((e) => e.custom?.Plural);
    expect(withPlural.length).toBeGreaterThan(500); // 520 in the sample
    expect(ir.lexicon.some((e) => e.custom?.Plural === 'pibubu')).toBe(true);
    const senseNotes = ir.lexicon.flatMap((e) => e.senses).filter((s) => s.custom?.['Parsing Note']);
    expect(senseNotes.length).toBeGreaterThan(50); // 60 in the sample
  });

  it('extracts coherent segments with words', () => {
    const segs = ir.texts.flatMap((t) => t.paragraphs.flatMap((p) => p.segments));
    expect(segs.length).toBeGreaterThan(0);
    const words = segs.flatMap((s) => s.analyses.filter((a) => a.kind === 'word'));
    expect(words.length).toBeGreaterThan(0);
    // every word has at least one vernacular form
    for (const w of words) expect(pickEn(w.forms) ?? Object.values(w.forms ?? {})[0]).toBeTruthy();
  });
});
