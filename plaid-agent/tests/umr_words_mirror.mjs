// plaid-umr's own rule for the words a node records (`wordsUnder` in
// sentenceGraph.js, what the canvas, Text mode and the import write as
// `umr.words`), over every aligned node of the released samples the app
// reads and a few anchors made to try it, so test_umr_words_mirror.py can
// hold the Python twin to it.
//
// Writes `[{words, pieces, ids}]` to stdout: a sentence's words, one node's
// anchor pieces as [begin, end], and the ids the rule records.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { wordsUnder } = await import(`${UMR}/src/domain/sentenceGraph.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);

const cases = [];
const add = (words, pieces) =>
  cases.push({
    words: words.map(({ id, begin, end }) => ({ id, begin, end })),
    pieces: pieces.map((p) => [p.begin, p.end]),
    ids: wordsUnder(pieces, words),
  });

// Made to try it: touching words (a text with no spaces), a piece over part
// of a word, pieces listed out of text order, words listed out of order, a
// point, and a piece over nothing.
const touching = [
  { id: "a", begin: 0, end: 1 },
  { id: "b", begin: 1, end: 3 },
  { id: "c", begin: 3, end: 4 },
  { id: "d", begin: 5, end: 9 },
];
add(touching, [{ begin: 1, end: 4 }]);
add(touching, [{ begin: 2, end: 3 }]);
add(touching, [{ begin: 5, end: 9 }, { begin: 0, end: 1 }]);
add([...touching].reverse(), [{ begin: 0, end: 4 }]);
add(touching, [{ begin: 3, end: 3 }]);
add(touching, [{ begin: 4, end: 5 }]);
add(touching, [{ begin: 0, end: 9 }, { begin: 1, end: 4 }]);

const dir = `${UMR}/test/fixtures/umr`;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".umr"))) {
  const plan = planImport(
    parseUmrFile(fs.readFileSync(`${dir}/${f}`, "utf8")).sentences,
    [],
  );
  const doc = new UmrDocument({ raw: rawFromPlan(plan) });
  doc.graph.sentences.forEach((s) =>
    s.nodes.forEach((n) => {
      if (n.aligned) add(s.words, n.pieces);
    }),
  );
}
process.stdout.write(JSON.stringify(cases));
