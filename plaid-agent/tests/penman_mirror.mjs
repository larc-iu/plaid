// plaid-umr's own PENMAN reader, run over the cases test_penman_mirror.py
// lists, so the shared Python reader in plaid_client.workflows.umr can be
// compared against it text by text.
//
// Reads a JSON array of texts as argv[2] and writes one result object per text
// to stdout, or reads `{texts, values, variables}` and writes the same keys, a
// value's result being what valueGrammarProblem says of `[value, rel]` and a
// variable's what nextVariable names for `[sentence, concept, taken]`. The one
// package the modules import is stubbed below, so this needs no node_modules:
// `node penman_mirror.mjs cases.json` from anywhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const PENMAN = resolve(HERE, '../../plaid-umr/src/domain/format/penman.js');
const VALIDATE = resolve(HERE, '../../plaid-umr/src/domain/format/validate.js');
const { parsePenman, serializePenman, treeEdges } = await import(PENMAN);
// validate.js imports only its siblings, so this still needs no node_modules.
const { valueGrammarProblem } = await import(VALIDATE);
// nextVariable lives in sentenceGraph.js, whose imports reach the client
// package for helpers nextVariable never calls. A stub stands in for it, so
// this still runs where plaid-umr has no node_modules.
const STUB =
  'data:text/javascript,export const cpSlicer = null, ROLES = {}, findByRole = () => null;';
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        if (spec !== '@larc-iu/plaid-client') return next(spec, ctx);
        return { url: ${JSON.stringify(STUB)}, shortCircuit: true };
      }`,
    ),
);
const { nextVariable } = await import(resolve(HERE, '../../plaid-umr/src/domain/sentenceGraph.js'));

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// An array of texts, or `{texts, values}` with values for valueGrammarProblem.
const texts = Array.isArray(input) ? input : input.texts;

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

process.stdout.write(
  JSON.stringify(
    Array.isArray(input)
      ? texts.map(shapeOf)
      : {
          texts: texts.map(shapeOf),
          values: input.values.map(([value, rel]) => valueGrammarProblem(value, rel)),
          variables: (input.variables ?? []).map(([index, concept, taken]) =>
            nextVariable(index, concept, new Set(taken)),
          ),
        },
  ),
);
