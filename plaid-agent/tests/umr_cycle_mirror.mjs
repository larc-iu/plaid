// plaid-umr's own cycle rule (`cycleEdges` in format/penman.js, what the
// canvas and Text mode refuse), over every sentence graph of the released
// samples the app reads and a few made to break it, so
// test_umr_cycle_mirror.py can hold the Python twin to it.
//
// Writes `[{text, edges}]` to stdout: each graph as PENMAN, and the edges
// that close a cycle as [source, rel, target].
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { parsePenman, cycleEdges } = await import(
  `${UMR}/src/domain/format/penman.js`
);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);

const texts = [
  "(s1a / say-01 :ARG0 (s1p / person) :ARG1 (s1b / believe-01 :ARG0 s1p :quote s1a))",
  "(s1a / say-01 :ARG1 (s1b / believe-01 :ARG2 s1a))",
  "(s1a / a :mod s1a)",
  "(s1a / a :quote s1a)",
  "(s1t / thing :ARG1-of (s1s / see-01 :ARG2 (s1d / dog :ARG0 s1t)))",
  "(s1x / x :modal-predicate (s1y / y :ARG0 s1x) :op1 (s1z / z :mod (s1w / w :mod s1z)))",
];
const dir = `${UMR}/test/fixtures/umr`;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".umr"))) {
  const plan = planImport(
    parseUmrFile(fs.readFileSync(`${dir}/${f}`, "utf8")).sentences,
    [],
  );
  const doc = new UmrDocument({ raw: rawFromPlan(plan) });
  doc.graph.sentences.forEach((s) => {
    if (s.nodes.length) texts.push(doc.penmanOf(s.index));
  });
}
const out = texts.map((text) => ({
  text,
  edges: cycleEdges(parsePenman(text)),
}));
process.stdout.write(JSON.stringify(out));
