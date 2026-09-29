// What a built-in rule stamps beside its output, for a reader of the record
// who wants to know which code wrote a value: `provDetail.model` and
// `provDetail.version`, the same two keys every bundled service writes (the
// core manual, "Provenance").
//
// `model` is `builtin:<name>`, the name the operation's ref uses too. `version`
// is `<package version>+<8 hex>`: this app's package version, then the start
// of a SHA-256 over every file whose change changes what the rule writes, as
// builtinSources.json lists them. Those are the rule's own file, autoPass.js
// (which runs it), the mutation that writes its output, every file of igt and
// plaid-ui they import (precedent.js among them), and the client's provenance
// helpers. What is hashed is one `sha256sum` line per file (`<sha256>  <path>`,
// in path order), so the manual's `git show` recipe over those paths gives the
// same 8 hex digits. The files are read as the bundle holds them (`?raw`),
// with the line endings the repository stores, and hashed once per page.

import { version } from '../../package.json';
import BUILTIN_SOURCES from './builtinSources.json';

const hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const sourceHash = async (paths) => {
  const { SOURCE_TEXTS } = await import('./builtinSourceTexts.js');
  const lines = await Promise.all(
    paths.map(async (p) => `${await hex(SOURCE_TEXTS[p].replace(/\r\n/g, '\n'))}  ${p}\n`),
  );
  return (await hex(lines.join(''))).slice(0, 8);
};

const details = new Map();

// `{ model, version }` for the built-in rule `name`.
export const builtinDetail = (name) => {
  if (!(name in BUILTIN_SOURCES)) throw new Error(`No built-in rule named ${name}`);
  if (!details.has(name)) {
    details.set(
      name,
      sourceHash(BUILTIN_SOURCES[name]).then((h) => ({
        model: `builtin:${name}`,
        version: `${version}+${h}`,
      })),
    );
  }
  return details.get(name);
};

// The operation a built-in rule's writes are, for the audit log: a service run
// naming the rule.
export const builtinRun = (name) => ({ kind: 'service-run', ref: `builtin:${name}` });
