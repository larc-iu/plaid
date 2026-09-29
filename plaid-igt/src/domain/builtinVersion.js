// What a built-in rule stamps beside its output, for a reader of the record
// who wants to know which code wrote a value: `provDetail.model` and
// `provDetail.version`, the same two keys every bundled service writes (the
// core manual, "Provenance").
//
// `model` is `builtin:<name>`, the name the operation's ref uses too. `version`
// is `<package version>+<8 hex>`: this app's package version, then the start
// of a SHA-256 of the file that holds the rule, so `git show <commit>:<path> |
// sha256sum` tells whether that commit's rule wrote a value. The file is read
// as the bundle holds it (`?raw`), and hashed once per page.

import { version } from '../../package.json';
import analysisCopySource from './analysisMemory.js?raw';
import precedentSource from './autoLink.js?raw';
import { BUILTIN_ANALYSIS_COPY, BUILTIN_LINK_PRECEDENT } from './serviceDefaults.js';

// The file each stamping rule lives in, by its name.
const SOURCES = {
  [BUILTIN_ANALYSIS_COPY]: analysisCopySource,
  [BUILTIN_LINK_PRECEDENT]: precedentSource,
};

const hash8 = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const details = new Map();

// `{ model, version }` for the built-in rule `name`.
export const builtinDetail = (name) => {
  if (!(name in SOURCES)) throw new Error(`No built-in rule named ${name}`);
  if (!details.has(name)) {
    details.set(
      name,
      hash8(SOURCES[name]).then((h) => ({ model: `builtin:${name}`, version: `${version}+${h}` })),
    );
  }
  return details.get(name);
};

// The operation a built-in rule's writes are, for the audit log: a service run
// naming the rule.
export const builtinRun = (name) => ({ kind: 'service-run', ref: `builtin:${name}` });
