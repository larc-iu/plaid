// The LaTeX book compiled for real, when a TeX Live with LuaLaTeX is on PATH
// or in PLAID_TEX_BIN (skipped otherwise, as the fidelity validator does).
// A person who runs lualatex by hand once gets an empty table of contents,
// and the page has to say so. The second run fills it in.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLatexBook,
  chapterEntryIds,
  defaultLatexOptions,
  entryAnchor,
  formatChapter,
  formatVocabulary,
  latexSelection,
  latexVocabulary,
} from './latexBook.js';
import { makeFixtureDoc, makeSentence } from './testFixtures.js';

const TEX_BIN = process.env.PLAID_TEX_BIN || null;
const lualatex = TEX_BIN ? path.join(TEX_BIN, 'lualatex') : 'lualatex';
const haveTex = (() => {
  try {
    execFileSync(lualatex, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const LAYERS = {
  orthographies: ['Translit'],
  wordFields: ['POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  hasMorphemes: true,
  fieldLangs: {},
};

describe.skipIf(!haveTex)('the LaTeX book compiled with LuaLaTeX', () => {
  it('fills in the table of contents on the second run, and says so on the first', () => {
    const sel = latexSelection(defaultLatexOptions(LAYERS), LAYERS);
    const texts = ['The Fox & the Crow', 'ʔaŋ ɓà'].map((name) => {
      const doc = makeFixtureDoc();
      doc.document.name = name;
      return { name, tex: formatChapter(doc, sel) };
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-latex-'));
    try {
      for (const f of buildLatexBook({ title: 'Book', texts, projectConfig: {} })) {
        fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
        fs.writeFileSync(path.join(dir, f.path), f.data);
      }
      const run = () =>
        execFileSync(lualatex, ['-interaction=nonstopmode', 'main.tex'], {
          cwd: dir,
          stdio: 'ignore',
          timeout: 120_000,
        });
      run();
      expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).toContain(
        'The table of contents is empty. Rerun',
      );
      run();
      expect(fs.readFileSync(path.join(dir, 'main.log'), 'utf8')).not.toContain(
        'The table of contents is empty',
      );
      const toc = fs.readFileSync(path.join(dir, 'main.toc'), 'utf8');
      expect(toc).toContain('{Abbreviations}');
      expect(toc).toContain('The Fox \\& the Crow');
      expect(toc).toContain('ʔaŋ ɓà');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('links each linked word and morpheme to its entry in the vocabulary, every destination there once', () => {
    const items = [
      { id: 'k1', form: 'kai', metadata: { gloss: 'go' } },
      { id: 'k2', form: 'kai', metadata: { gloss: 'eat' } },
      { id: 'k2a', form: 'kai', metadata: { gloss: 'devour', parent: 'k2' } },
      { id: 'na', form: '-na', metadata: { gloss: 'PST', morphType: 'suffix' } },
      { id: 'ar', form: 'كتب', metadata: { gloss: 'books' } },
      { id: 'idle', form: 'zu', metadata: { gloss: 'never used' } },
    ];
    const vocab = { id: 'v', name: 'Lexicon', config: {}, items };
    const ref = (id) => ({ id, form: items.find((it) => it.id === id).form });
    const morph = (form, gloss, id, morphType = null) => ({
      content: form,
      metadata: { form, ...(morphType ? { morphType } : {}) },
      morphType,
      annotations: { Gloss: { value: gloss } },
      vocabItem: ref(id),
    });
    const tok = (content, morphemes, vocabItem = null) => ({
      content,
      annotations: {},
      orthographies: {},
      morphemes,
      vocabItem: vocabItem && ref(vocabItem),
    });
    const doc = (name, dir, tokens) => ({
      document: { name, metadata: {} },
      textDirection: dir,
      sortedSentences: [makeSentence({ begin: 0, end: 1, tokens })],
    });
    const layers = { ...LAYERS, orthographies: [], wordFields: [] };
    const sel = latexSelection(defaultLatexOptions(layers), layers);
    const choice = latexVocabulary({ vocabulary: { scope: 'all' } }, [vocab]);
    const entries = chapterEntryIds([vocab], choice);
    const docs = [
      doc('One', 'ltr', [
        // an allomorph (ke) of kai 1, and a sense
        tok('kena', [morph('ke', 'go', 'k1'), morph('na', 'PST', 'na', 'suffix')]),
        tok('kaina', [morph('kai', 'devour', 'k2a'), morph('na', 'PST', 'na', 'suffix')]),
        tok('Kai', [], 'k2'),
        tok('{x}', []),
      ]),
      doc('كتب', 'rtl', [tok('كتب', [morph('كتب', 'books', 'ar')], 'ar')]),
    ];
    const texts = docs.map((d) => ({
      name: d.document.name,
      tex: formatChapter(d, sel, { entries }),
    }));
    const vocabulary = formatVocabulary({ vocabularies: [vocab], choice });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-latex-'));
    try {
      for (const f of buildLatexBook({ title: 'Book', texts, projectConfig: {}, vocabulary })) {
        fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
        // Uncompressed, so the test can read the links out of the PDF.
        const data =
          f.path === 'main.tex'
            ? `\\pdfvariable compresslevel=0 \\pdfvariable objcompresslevel=0\n${f.data}`
            : f.data;
        fs.writeFileSync(path.join(dir, f.path), data);
      }
      const run = () =>
        execFileSync(lualatex, ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], {
          cwd: dir,
          stdio: 'ignore',
          timeout: 120_000,
        });
      run();
      run();
      const log = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
      expect(log).not.toMatch(/^!/m);
      expect(log).not.toMatch(
        /same identifier|destination .* undefined|unknown named destination/i,
      );
      const pdf = fs.readFileSync(path.join(dir, 'main.pdf'), 'latin1');
      const name = (id) => `plaidentry.${entryAnchor(id)}`;
      const count = (re) => (pdf.match(re) || []).length;
      const linkCount = (id) => count(new RegExp(`/D\\s*\\(${name(id)}\\)`, 'g'));
      // kai 1 from its allomorph, the sense, -na twice, kai 2 from the word,
      // and the Arabic entry from its word (a word that is its one morpheme
      // has no morpheme line).
      expect([linkCount('k1'), linkCount('k2a'), linkCount('na'), linkCount('k2')]).toEqual([
        1, 1, 2, 1,
      ]);
      expect(linkCount('ar')).toBe(1);
      // Each entry is a destination once, the unused one included.
      for (const it of items) {
        expect(count(new RegExp(`\\(${name(it.id)}\\)`, 'g')) - linkCount(it.id), it.id).toBe(1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
