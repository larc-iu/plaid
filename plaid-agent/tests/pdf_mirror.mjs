// plaid-ui's half of reading a PDF (pdfText.js, and the cutting of a file into
// stored parts in attachments.js), run over the cases test_pdf_mirror.py
// generates, so the service's pdftext.py and files.py can be compared with it.
// A case naming a fixture is read with real pdf.js, from plaid-igt's
// node_modules.
//
// Reads a cases JSON path as argv[2] and writes the results to stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ui = `${ROOT}/plaid-ui/src/components/assistant`;
const pdf = await import(`${ui}/pdfText.js`);
const { chunk, storedBytes } = await import(`${ui}/attachments.js`);

let pdfjs = null;
const loadPdfjs = async () => {
  if (!pdfjs) {
    const path = `${ROOT}/plaid-igt/node_modules/pdfjs-dist/legacy/build/pdf.mjs`;
    pdfjs = await import(pathToFileURL(path).href);
  }
  return pdfjs;
};

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
for (const c of cases) {
  if (c.kind === 'clean') results.push(pdf.cleanText(c.text));
  else if (c.kind === 'layout') results.push(pdf.layoutPage(pdf.runsFromItems(c.items)));
  else if (c.kind === 'assemble') results.push(pdf.assemble(c.pages, c.labels, c.sections));
  else if (c.kind === 'scan') results.push([pdf.isScan(c.pages), pdf.emptyPages(c.pages)]);
  else if (c.kind === 'chunk') results.push([chunk(c.text, c.budget), storedBytes(c.text)]);
  else if (c.kind === 'file') {
    const lib = await loadPdfjs();
    const data = new Uint8Array(readFileSync(c.path));
    const doc = await lib.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise;
    const got = await pdf.pdfText(doc);
    results.push({ text: got.text, pages: got.pages, empty: got.empty, scan: got.scan });
  } else results.push(null);
}
process.stdout.write(JSON.stringify(results));
