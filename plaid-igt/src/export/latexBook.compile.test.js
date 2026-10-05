// The LaTeX book compiled for real, when a TeX Live with LuaLaTeX is on PATH
// or in PLAID_TEX_BIN (skipped otherwise, as the fidelity validator does).
// A person who runs lualatex by hand once gets an empty table of contents,
// and the page has to say so. The second run fills it in.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLatexBook, defaultLatexOptions, formatChapter, latexSelection } from './latexBook.js';
import { makeFixtureDoc } from './testFixtures.js';

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
});
