// plaid-ud's own sentence rows (`buildSentenceRows`, through a ConlluDocument
// opened as the editor opens it), over the documents test_ud_rows_mirror.py
// generates, so the ud assistant's reader can be held to the numbering the
// grid's ID column and the export show, stand-ins for words with no UD word
// included.
//
// Reads a cases JSON path as argv[2] and writes, per case, every row as
// {sentence number, sentence id, words: [[CoNLL-U id, word id, form, stand-in]]}
// to stdout. The number is the row's place, which the grid's header, Ask and
// `@` show (`s${i + 1}`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const UD = resolve(dirname(fileURLToPath(import.meta.url)), '../../plaid-ud');
const { ConlluDocument } = await import(`${UD}/src/domain/ConlluDocument.js`);

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = cases.map((raw) => {
  const doc = new ConlluDocument({ raw: structuredClone(raw) });
  return doc.sentences.map((row, i) => ({
    n: i + 1,
    id: row.id,
    words: row.tokens.map((t) => [t.tokenIndex, t.token.id, t.tokenForm, Boolean(t.virtual)]),
  }));
});
process.stdout.write(JSON.stringify(out));
