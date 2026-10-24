import { describe, it, expect } from 'vitest';
import { gitGrep, scratchRepo, unmarked } from './src/test/repoGates.js';
import { repoRoot } from './src/test/apps.js';

// No behaviour from a name (memory feedback_no_guessing_from_names.md): what a
// layer, field or tagset IS comes from its stored config, and a name may only
// propose a stored value when the thing is made. Beta review A1 found every
// break of this by reading, after the fact. This gate finds the shapes those
// breaks took, in every package's source, as soon as one is written.
//
// A line it finds fails the build unless that line, or the line above, says
// why it is fine (a run of hits on consecutive lines shares one marker):
//
//     // name-ok: A15 built-in entry key
//     # name-ok: proposal at creation
//
// The reason stays at the site and moves with the code, rather than in a list
// here. The reasons in use: "A15 built-in entry key" (an entry field's stored
// key, not a display name), "entry field key" (likewise, for a field of any
// name), "proposal at creation", "format grammar" (the name is the file
// format's own identifier), "DOM id", "display only", "within one project"
// (telling a package's own layers apart, rulings C1 and C4), "cache key", "a
// file extension", and the fake client's own resource name.
//
// What it cannot see: a name used as a lookup key into a hand-written table,
// or a comparison spelled some other way. Those still need a reader.

const PATHSPECS = [
  'plaid-*/src/**',
  'plaid-*/services/*.py',
  ':!*.test.*',
  ':!**/test/**',
  ':!**/tests/**',
  ':!**/e2e/**',
  ':!**/src/data/**',
];

const DOMAIN =
  'gloss|pos|lemma|translation|literal translation|note|morph\\w*|upos|xpos|features?|form|status|definition|baseline|main text|ipa|words?|sentences?|tokens?';

const PATTERNS = {
  // A domain word compared to anything called a name (JS and Python), and the
  // reverse.
  'a name compared to a domain word': `\\b\\w*[Nn]ame\\w*\\)?\\s*(===|!==|==|!=)\\s*['"](?i:${DOMAIN})['"]`,
  'a domain word compared to a name': `['"](?i:gloss|pos|lemma|translation|morph\\w*|upos|xpos|form|status|definition|baseline)['"]\\s*(===|!==|==|!=)\\s*\\w*[Nn]ame\\b`,
  // A regex literal with a domain word in it (JS).
  'a regex literal with a domain word': `(?i)(^|[=(,:!&|?]\\s*)/(?![*/])[^/\\n]*(gloss|lemma|translat|upos|xpos|meaning|sense|definition|status|\\bpos\\b|morph|literal|note|comment)[^/\\n]*/[gimsuy]*(?=[.,);\\s]|$)`,
  // Python regexes and lowercased names.
  'a Python regex with a domain word': `re\\.(search|match|fullmatch)\\(\\s*r?['"][^'"]*(?i:gloss|lemma|translat|pos|meaning)`,
  'a name tested by its start or end': `(\\.name|\\[.name.\\]|get\\(.name.\\))(\\.(lower|casefold)\\(\\))?\\.(startswith|endswith)\\(['"]`,
  // Clojure.
  'a Clojure name matched': `(re-find|re-matches|str/includes\\?|str/starts-with\\?)[^\\n]*(:[\\w.-]+/name|\\(:name )`,
  // One name compared to another (A1-1's shape): a layer taken as a field
  // because the two are called the same. Within one project a package may
  // tell its own layers apart by name, so each one says that it is.
  'one name compared to another': `\\.name\\b\\s*(===|!==|==|!=)\\s*[\\w$?.]+\\.name\\b|\\[['"]name['"]\\]\\s*(==|!=)\\s*[\\w.]+\\[['"]name['"]\\]|get\\(['"]name['"]\\)\\s*(==|!=)\\s*[\\w.]+\\.get\\(['"]name['"]\\)`,
};

const offenders = (root) =>
  unmarked(root, gitGrep(root, Object.values(PATTERNS), PATHSPECS), 'name-ok');

const failure = (found) =>
  `A name decides behaviour here (memory feedback_no_guessing_from_names.md):\n  ${found.join('\n  ')}\n` +
  'Read the stored config (a role, a scope, a flag) instead. If the name is only a proposal made at ' +
  'creation, a stored key, or a format’s own identifier, say so with a comment on the line or the ' +
  'line above: `// name-ok: <reason>` (or `# name-ok: <reason>` in Python).';

describe('no behaviour from a name', () => {
  it('holds over every package', () => {
    const found = offenders(repoRoot());
    expect(found, failure(found)).toEqual([]);
  });

  it('finds each shape and lets a marked line through', () => {
    const root = scratchRepo({
      'plaid-x/src/bad.js': [
        "if (layer.name === 'Gloss') use(layer);",
        "const t = fields.find(() => 'translation' == fieldName);",
        'const pick = layers.filter((l) => looksLike(l.name, /translat|free/i));',
        'const same = (sl) => sl.name === field.name;',
        '',
      ].join('\n'),
      'plaid-x/services/bad.py': [
        "if re.search(r'gloss', layer['name']):",
        '    pass',
        "if layer['name'].lower().startswith('trans'):",
        '    pass',
        "same = a['name'] == b['name']",
        '',
      ].join('\n'),
      'plaid-x/src/main/bad.clj': '(when (re-find #"gloss" (:name layer)) :gloss)\n',
      'plaid-x/src/clean.js': [
        '// a comment about why layer.name === field.name is not enough',
        "if (readRole(layer.config) === 'gloss') use(layer);",
        "const n = name === 'x' ? 1 : 2;",
        '// name-ok: A15 built-in key',
        "if (field.name === 'morphType') edit(field);",
        "if (field.name === 'gloss') show(field); // name-ok: A15 built-in key",
        '// name-ok: proposal at creation',
        "if (looksLike(name, /gloss/i)) header = 'gloss';",
        "else if (looksLike(name, /pos/i)) header = 'pos';",
        '',
        "else if (looksLike(name, /note/i)) header = 'note';",
        '',
      ].join('\n'),
      // Tests and data are not what the apps run.
      'plaid-x/src/bad.test.js': "if (layer.name === 'Gloss') use(layer);\n",
      'plaid-x/src/data/frames.js': "if (layer.name === 'Gloss') use(layer);\n",
    });
    const found = offenders(root).map((row) => row.split(':').slice(0, 2).join(':'));
    expect(found).toEqual([
      'plaid-x/services/bad.py:1',
      'plaid-x/services/bad.py:3',
      'plaid-x/services/bad.py:5',
      'plaid-x/src/bad.js:1',
      'plaid-x/src/bad.js:2',
      'plaid-x/src/bad.js:3',
      'plaid-x/src/bad.js:4',
      'plaid-x/src/clean.js:1',
      'plaid-x/src/clean.js:11',
      'plaid-x/src/main/bad.clj:1',
    ]);
  });

  it('wants a reason, not only the marker', () => {
    const root = scratchRepo({
      'plaid-x/src/a.js': "// name-ok:\nif (field.name === 'gloss') show(field);\n",
      'plaid-x/src/b.js': "// name-ok: ok\nif (field.name === 'gloss') show(field);\n",
    });
    expect(offenders(root)).toHaveLength(2);
  });
});
