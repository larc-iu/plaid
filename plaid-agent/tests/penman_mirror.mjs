// plaid-umr's own PENMAN reader, run over the cases test_penman_mirror.py
// lists, so the shared Python reader in plaid_client.workflows.umr can be
// compared against it text by text.
//
// Reads a JSON array of texts as argv[2] and writes one result object per text
// to stdout. The module has no imports of its own, so this needs no
// node_modules: `node penman_mirror.mjs cases.json` from anywhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PENMAN = resolve(HERE, '../../plaid-umr/src/domain/format/penman.js');
const { parsePenman, serializePenman, treeEdges } = await import(PENMAN);

const texts = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const shapeOf = (text) => {
  const g = parsePenman(text);
  const nodes = {};
  for (const [variable, node] of g.nodes) {
    nodes[variable] = {
      concept: node.concept,
      // `value` is null where a child node could not be read at all; the two
      // sides say so differently, and both are error cases, so it is compared
      // as the empty string.
      children: node.children.map((c) => [c.rel, c.kind, c.value ?? '']),
    };
  }
  return {
    root: g.root ?? null,
    nodes,
    // The decision both readers act on: a text with errors or with no root is
    // not one anything may be written from.
    refused: g.errors.length > 0 || g.root === null,
    // Written back out, which is the half a diff compares against a person's
    // edit. A refused text serializes to '' on both sides.
    text: serializePenman(g),
    treeEdges: [...treeEdges(g)].map(([parent, index]) => [parent, index]).sort(),
  };
};

process.stdout.write(JSON.stringify(texts.map(shapeOf)));
