// plaid-umr's own reading of an alignment block (`readAlignment` in
// format/umrFile.js, what Text mode anchors a mended kept graph's new nodes
// by), over every alignment block of the released samples the app reads and
// a few blocks made to try it, so test_umr_alignment_mirror.py can hold the
// Python twin (`read_alignment` in plaid_agent.umr.diff) to it.
//
// Writes `[{block, ranges}]` to stdout: the block's text, and each variable
// with the ranges the rule reads, in the order the block names them.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile, readAlignment } = await import(
  `${UMR}/src/domain/format/umrFile.js`
);

const cases = [];
const add = (block) =>
  cases.push({ block, ranges: [...readAlignment(block).entries()] });

// Made to try it: unaligned values (0-0, UMR 1.0's -1--1, empty), several
// ranges, spaces around the colon and the commas, a comment, a line with no
// colon, a range that cannot be read, a variable named twice, blank lines.
add("s1a: 1-1\ns1b: 0-0\ns1c: -1--1\ns1d:");
add("s2a: 1-2, 4-4\n  s2b :3-3 ,5-6  \n\n# a comment\ns2c 7-7\ns2d: x-1, 2-2");
add("s3a: 1-1\ns3a: 2-2\ns3b: 03-04\ns3c: 1- 2");

const dir = `${UMR}/test/fixtures/umr`;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".umr"))) {
  for (const s of parseUmrFile(fs.readFileSync(`${dir}/${f}`, "utf8"))
    .sentences) {
    if (s.raw?.alignment) add(s.raw.alignment);
  }
}
process.stdout.write(JSON.stringify(cases));
