// Real .flextext files, checked against the .fwbackup they came from. The 14
// texts in ~/Downloads/lezgi.flextext (FieldWorks' own export, September 2022)
// are all in ~/Downloads/fwbackup/lezgi.fwbackup (July 2022) under the same
// guids, so the backup import is an oracle for the .flextext one: the same
// words, the same text up to its spacing, and every gloss and analysis the
// backup has. The .flextext is the later of the two, and holds analyses made
// in between, which is why the comparison runs one way. Skipped when either
// file is absent (CI).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseFlextextFiles } from './flextextParser.js';
import { readFwbackup } from './fwbackup.js';
import { parseFwdata } from './fwdataParser.js';
import { buildDocuments } from './buildDocuments.js';

const FLEXTEXT = '/home/luke/Downloads/lezgi.flextext';
const BACKUP = '/home/luke/Downloads/fwbackup/lezgi.fwbackup';

const surfaces = (doc) => doc.words.map((w) => doc.body.slice(w.begin, w.end));
const morphs = (w) => {
  const list = (w?.morphemes ?? []).map((m) => [
    Object.values(m.forms ?? {})[0],
    m.gloss?.en,
    m.morphType,
  ]);
  // One bare morph that is only the word again is the word unsegmented, which
  // is how the .flextext reader takes it (see readWord).
  const [only] = list;
  const bare =
    list.length === 1 && !only[1] && !only[2] && Object.values(w.forms).includes(only[0]);
  return JSON.stringify(bare ? [] : list);
};

describe.skipIf(!existsSync(FLEXTEXT) || !existsSync(BACKUP))('lezgi.flextext', () => {
  // Read in beforeAll, as every other sample test in this directory does:
  // `skipIf` skips the TESTS, but vitest still runs the describe body to
  // collect them, so a read out here throws on a machine without the files
  // and takes the whole suite with it.
  let ir, build, pairs;
  beforeAll(() => {
    ir = parseFlextextFiles([{ name: 'lezgi.flextext', xml: readFileSync(FLEXTEXT, 'utf8') }]);
    build = buildDocuments(ir);
    const backup = buildDocuments(parseFwdata(readFwbackup(readFileSync(BACKUP)).xml));
    const fromBackup = new Map(backup.documents.map((d) => [d.guid, d]));
    pairs = build.documents.map((d) => [d, fromBackup.get(d.guid)]);
  });

  it('reads every text and aligns every word', () => {
    expect(build.stats).toMatchObject({
      documents: 14,
      sentences: 874,
      words: 8052,
      unalignedWords: 0,
      warnings: 0,
    });
    expect(ir.warnings).toEqual([]);
    expect(pairs.every(([, o]) => o)).toBe(true);
  });

  it('has the words of the backup, in its order', () => {
    for (const [d, o] of pairs) expect(surfaces(d)).toEqual(surfaces(o));
  });

  it('rebuilds the text of the backup, up to its spacing', () => {
    const squeeze = (s) => s.replace(/\s+/g, '');
    for (const [d, o] of pairs) expect(squeeze(d.body)).toBe(squeeze(o.body));
  });

  it('keeps every word gloss, category and analysis the backup has', () => {
    let revised = 0;
    for (const [d, o] of pairs) {
      d.words.forEach((w, i) => {
        const was = o.words[i];
        if (was.gloss?.en) expect([w.gloss?.en, d.name]).toEqual([expect.any(String), d.name]);
        // A category is named per writing system on both sides. The backup
        // holds every name FieldWorks has for it, the .flextext only the
        // ones it was exported with, so the backup contains what the file
        // read and agrees on each.
        if (was.pos && w.pos) expect(was.pos).toMatchObject(w.pos);
        if (was.morphemes?.length && morphs(w) !== morphs(was)) revised += 1;
      });
    }
    // Analyses a linguist changed between the two exports ("-ай" became "-яй").
    expect(revised).toBeLessThan(100);
  });

  // Under whichever writing system the file names: FieldWorks labels an item
  // by the writing system of its first character, so one English translation
  // that opens with two direction marks typed in the vernacular goes out
  // tagged as vernacular, which is where FLEx itself would file it on import.
  it('keeps the translations, up to trailing space', () => {
    let relabelled = 0;
    for (const [d, o] of pairs) {
      d.sentences.forEach((s, i) => {
        const was = o.sentences[i].freeTranslation?.en?.trim();
        if (!was) return;
        const now = Object.entries(s.freeTranslation ?? {}).find(([, t]) => t === was);
        expect(now?.[1]).toBe(was);
        if (now[0] !== 'en') relabelled += 1;
      });
    }
    expect(relabelled).toBe(1);
  });
});
