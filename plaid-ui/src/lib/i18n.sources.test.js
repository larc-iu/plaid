import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import { APPS, repoRoot } from '../test/apps.js';
import { scanPath } from '../test/i18nCensus.js';
import { I18N_DONE } from '../test/i18nDone.js';
import { LANGUAGES } from './i18n.js';

// The catalogs against the code. A translation is only as good as its match
// to the message it translates: the same values, in a message that parses.
// And a directory that says it is finished shows nothing in English only.

const root = repoRoot();
const rel = (file) => path.relative(root, file).split(path.sep).join('/');
const PACKAGES = ['plaid-ui', ...APPS.map((a) => a.dir)];
const TRANSLATED = LANGUAGES.map((l) => l.code).filter((code) => code !== 'en');
// The values i18next reads for itself (see lib/i18n.js).
const RESERVED = new Set(['count', 'context', 'lng', 'lngs', 'ns', 'defaultValue', 'replace']);

const scanned = Object.fromEntries(
  PACKAGES.map((pkg) => [pkg, scanPath(path.join(root, pkg, 'src'))]),
);

// {message: {translation, file}} for one package and language, and the
// messages two of its files translate differently.
function readCatalog(pkg, lng) {
  const dir = path.join(root, pkg, 'src', 'locales', lng);
  const entries = new Map();
  const clashes = [];
  if (!fs.existsSync(dir)) return { entries, clashes };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = rel(path.join(dir, name));
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, name))))) {
      const had = entries.get(key);
      if (had && had.value !== value) clashes.push(`${key}: ${had.file} and ${file}`);
      entries.set(key, { value, file });
    }
  }
  return { entries, clashes };
}

// The names a message takes values under, tags included.
function valueNames(message, lng) {
  const names = new Set();
  const walk = (elements) => {
    for (const el of elements) {
      if (el.value !== undefined && el.type !== 0 && el.type !== 7) names.add(el.value);
      if (el.options) Object.values(el.options).forEach((o) => walk(o.value));
      if (el.children) walk(el.children);
    }
  };
  walk(new IntlMessageFormat(message, lng).getAst());
  return [...names].sort();
}

const parses = (message, lng) => {
  try {
    valueNames(message, lng);
    return true;
  } catch {
    return false;
  }
};

describe('the messages in the code', () => {
  it('each parse as ICU MessageFormat and name no value i18next reads itself', () => {
    const bad = [];
    for (const pkg of PACKAGES) {
      for (const f of scanned[pkg]) {
        for (const k of f.keys) {
          if (!parses(k.key, 'en')) bad.push(`${rel(f.file)}:${k.line} does not parse: ${k.key}`);
          else if (valueNames(k.key, 'en').some((n) => RESERVED.has(n))) {
            bad.push(`${rel(f.file)}:${k.line} names a reserved value: ${k.key}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe.each(TRANSLATED)('the %s catalogs', (lng) => {
  const shared = readCatalog('plaid-ui', lng);

  it.each(PACKAGES)('%s: every translation matches a message the code has', (pkg) => {
    const { entries, clashes } = readCatalog(pkg, lng);
    const used = new Set(scanned[pkg].flatMap((f) => f.keys.map((k) => k.key)));
    const bad = [...clashes.map((c) => `translated two ways: ${c}`)];
    for (const [key, { value, file }] of entries) {
      const at = `${file}: ${key}`;
      // common.json is the words every package shares, wherever they are used.
      if (!used.has(key) && !file.endsWith('/common.json')) {
        bad.push(`no such message in ${pkg}/src: ${at}`);
      }
      if (typeof value !== 'string' || value.trim() === '') bad.push(`empty: ${at}`);
      else if (!parses(value, lng)) bad.push(`does not parse: ${at}`);
      else if (String(valueNames(value, lng)) !== String(valueNames(key, 'en'))) {
        bad.push(`takes other values than its message: ${at}`);
      }
      // ICU reads a straight apostrophe as the start of quoted text.
      else if (value.includes("'")) bad.push(`straight apostrophe, write ’: ${at}`);
      // An app's catalog loads over the shared one, so it must not disagree.
      if (
        pkg !== 'plaid-ui' &&
        shared.entries.has(key) &&
        shared.entries.get(key).value !== value
      ) {
        bad.push(`translated otherwise in plaid-ui: ${at}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every finished path is all in messages, and every message is translated', () => {
    const bad = [];
    for (const done of I18N_DONE) {
      const pkg = done.split('/')[0];
      const own = readCatalog(pkg, lng).entries;
      const files = scanned[pkg].filter(
        (f) => rel(f.file) === done || rel(f.file).startsWith(`${done}/`),
      );
      if (!files.length) bad.push(`${done}: no such source`);
      for (const f of files) {
        for (const u of f.unwrapped) {
          if (u.kind !== 'sentence') bad.push(`${rel(f.file)}:${u.line} [${u.kind}] ${u.text}`);
        }
        for (const k of f.keys) {
          if (!own.has(k.key) && !shared.entries.has(k.key)) {
            bad.push(`${rel(f.file)}:${k.line} has no ${lng} translation: ${k.key}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
