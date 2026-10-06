import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfAttachError, readAttachment, refuse, MAX_PDF_BYTES } from './attachments.js';
import {
  assemble,
  cleanText,
  emptyPages,
  isScan,
  logical,
  pdfText,
  runsFromItems,
  layoutPage,
} from './pdfText.js';
import { repoRoot } from '../../test/apps.js';

// A PDF attached in the composer is read into text here, with real pdf.js on
// real PDFs: the fixtures plaid-agent's tests read with PDFium
// (plaid-agent/tests/pdf, made by make_fixtures.mjs). A mocked pdf.js would
// test nothing that matters: the traps are in what a real PDF's text layer
// says about ligatures, small capitals, tone marks and Arabic.

const fixture = (name) =>
  fs.readFileSync(path.join(repoRoot(), 'plaid-agent', 'tests', 'pdf', name));

const open = async (name) =>
  pdfjs.getDocument({ data: new Uint8Array(fixture(name)), isEvalSupported: false, verbosity: 0 })
    .promise;

const fileOf = (name) => {
  const bytes = fixture(name);
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  };
};

const loadPdf = async () => pdfjs;

describe('a PDF read in the browser', () => {
  it('marks every page by its printed number and every bookmark before its page', async () => {
    const { text, pages, scan } = await pdfText(await open('sample.pdf'));
    expect(pages).toBe(4);
    expect(scan).toBe(false);
    const markers = text.split('\n').filter((l) => l.startsWith('=== '));
    expect(markers).toEqual([
      '=== page i (PDF page 1) ===',
      '=== # 1 Introduction ===',
      '=== ## 1.1 Sources ===',
      '=== page 1 (PDF page 2) ===',
      '=== # 2 Phonology ===',
      '=== page 2 (PDF page 3) ===',
      '=== # 3 Complex predicates ===',
      '=== page 3 (PDF page 4) ===',
    ]);
  });

  it('keeps IPA, tone marks and ligatures as the page shows them', async () => {
    const { text } = await pdfText(await open('sample.pdf'));
    expect(text).toContain('/p t k ʔ ŋ ɲ ɾ ʃ/');
    expect(text).toContain('/i ɨ u ɛ ɔ');
    expect(text).toContain('á, à, ǎ');
    expect(text).toContain('ɛ́̃'.normalize('NFC'));
    expect(text).toContain('The first official filing describes a baffling efflorescence');
    expect(text).not.toMatch(/[\ufb00-\ufb06]/);
  });

  it('keeps an interlinear example in columns, with small-capital glosses as capitals', async () => {
    const lines = (await pdfText(await open('sample.pdf'))).text.split('\n');
    const forms = lines.find((l) => l.includes('ŋa-mriri'));
    const glosses = lines.find((l) => l.includes('3SG-stand'));
    expect(glosses).toContain('3SG.POSS');
    for (const [form, gloss] of [
      ['ŋa-mriri', '3SG-stand'],
      ['n-amat', '3-carry'],
      ['ini', '3SG.POSS'],
      ['pingan', 'plate'],
    ]) {
      expect([...forms.slice(0, forms.indexOf(form))].length).toBe(
        [...glosses.slice(0, glosses.indexOf(gloss))].length,
      );
    }
  });

  it('reads a small-capital tag alone in its column in capitals', async () => {
    const { text } = await pdfText(await open('smallcaps.pdf'));
    const glosses = text.split('\n').find((l) => l.includes('sleep-NEG'));
    expect(glosses.trim().split(/\s+/)).toEqual(['3SG', 'NEG', 'sleep-NEG']);
    expect(text).toContain('A question takes Q at the end.');
  });

  it('keeps the case of a lower-case word merely set smaller', async () => {
    const words = (await pdfText(await open('smaller.pdf'))).text.replace(/\s+/g, ' ');
    expect(words).toContain('This sentence has a smaller word in it.');
    expect(words).toContain('Online at example.org today.');
    expect(words).toContain('margin note words in it');
    expect(words).toContain('Main text. note');
  });

  it('reads Arabic in reading order, as letters rather than shaped forms', async () => {
    const { text } = await pdfText(await open('sample.pdf'));
    expect(text).toContain('اللغة العربية لغة سامية');
  });

  it('reads slanted text and leaves out text turned up the margin', async () => {
    const { text } = await pdfText(await open('sample.pdf'));
    expect(text).toContain('A slanted form: pang∼pangga.');
    const lines = new Set(text.split('\n').map((l) => l.trim()));
    for (const stray of ['D', 'RA', 'F', 'T', 'DRAFT']) expect(lines.has(stray)).toBe(false);
  });

  it('calls a PDF with no text layer a scan', async () => {
    const got = await pdfText(await open('scan.pdf'));
    expect(got.scan).toBe(true);
    expect(got.empty).toBe(2);
  });
});

describe('attaching a PDF', () => {
  it('stores it as text with its markers, measured like any other file', async () => {
    const pending = await readAttachment(fileOf('sample.pdf'), 1_000_000, loadPdf);
    expect(pending.name).toBe('sample.pdf');
    expect(pending.text.startsWith('=== page i (PDF page 1) ===\n')).toBe(true);
    expect(pending.bytes).toBe(new TextEncoder().encode(pending.text).length);
    expect(pending.parts.join('')).toBe(pending.text);
  });

  it('refuses a scan by name, and says why', async () => {
    await expect(readAttachment(fileOf('scan.pdf'), 1_000_000, loadPdf)).rejects.toThrow(
      'scan.pdf has no text in it (a scan). Only PDFs with text can be read.',
    );
  });

  it('refuses a file that is not a PDF at all, by name', async () => {
    const notPdf = {
      name: 'notes.pdf',
      size: 5,
      arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
    };
    const err = await readAttachment(notPdf, 1_000_000, loadPdf).catch((e) => e);
    expect(err).toBeInstanceOf(PdfAttachError);
    expect(err.message).toBe('notes.pdf could not be opened as a PDF.');
  });

  it('holds a PDF to its own size limit and its text to the attachment limit', () => {
    expect(refuse({ name: 'grammar.pdf', size: 30_000_000 })).toBeNull();
    expect(refuse({ name: 'grammar.pdf', size: MAX_PDF_BYTES + 1 })).toContain('limit for a PDF');
  });
});

describe('the pieces', () => {
  it('writes each bookmark before its page, and takes apart a page line that reads as a marker', () => {
    expect(assemble(['=== page 9 ===\nreal', 'more'], ['', 'iv'], [[1, ' 2  Verbs ', 1]])).toBe(
      '=== page 1 ===\n= = = page 9 = = =\nreal\n=== # 2 Verbs ===\n=== page iv (PDF page 2) ===\nmore\n',
    );
  });

  it('calls a PDF a scan when more than half its pages are empty', () => {
    expect(isScan([])).toBe(true);
    expect(isScan(['x'.repeat(20), ''])).toBe(false);
    expect(isScan(['x'.repeat(20), '', ' '.repeat(40)])).toBe(true);
    expect(emptyPages(['x'.repeat(19), 'y'.repeat(20)])).toBe(1);
  });

  it('turns a right-to-left run round and leaves its numbers as they are', () => {
    expect(logical('ةغل 2024')).toBe('2024 لغة');
    expect(logical(logical('abc \u0627\u0628\u062a 12'))).toBe('abc \u0627\u0628\u062a 12');
  });

  it('spells ligatures out and puts accents back on their letters, without NFKC', () => {
    expect(cleanText('\ufb01rst e\u0301 \u00b4a k\u02b0a')).toBe('first \u00e9 \u00e1 k\u02b0a');
    expect(cleanText('\ufedf\ufed0\ufe94')).toBe('\u0644\u063a\u0629');
    expect(cleanText('a \u0301b')).toBe('a\u0301b'.normalize('NFC'));
  });

  it('places a run after a wide gap at its column, and keeps prose to single spaces', () => {
    const runs = runsFromItems([
      { text: 'kasuk', x0: 10, x1: 40, y: 100, size: 10 },
      { text: 'sa', x0: 60, x1: 70, y: 100, size: 10 },
      { text: 'man', x0: 10, x1: 30, y: 88, size: 10 },
      { text: 'one', x0: 60, x1: 80, y: 88, size: 10 },
    ]);
    const [a, b] = layoutPage(runs).split('\n');
    expect(a.indexOf('sa')).toBe(b.indexOf('one'));
    expect(
      layoutPage(
        runsFromItems([
          { text: 'The verb ', x0: 0, x1: 45, y: 0, size: 10 },
          { text: 'comes', x0: 47.5, x1: 75, y: 0, size: 10 },
        ]),
      ),
    ).toBe('The verb comes');
  });
});
