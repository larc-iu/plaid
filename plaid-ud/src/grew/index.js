// Public entry point for the Grew → Plaid-QL pipeline.
//
//   parseAndCompile(text, layerInfo, { projectId, limit })
//     -> { query, warnings, impossible }
//
// `query` is ready to hand to `client.query()`. `warnings` are non-fatal notes
// to surface to the user (e.g. `sent_id` won't match imported data).
// `impossible` is true when a constraint was constant-folded to "never matches"
// (e.g. `global { is_cyclic }` against the UD tree invariant) — the caller
// should report zero results without calling the server.

import { parse } from './parser.js';
import { compileGrew } from './compile.js';

export { GrewError, GrewParseError, GrewUnsupportedError } from './errors.js';
export { parse } from './parser.js';
export { compileGrew } from './compile.js';

export function parseAndCompile(text, layerInfo, opts = {}) {
  const ast = parse(text);
  return compileGrew(ast, layerInfo, opts);
}
