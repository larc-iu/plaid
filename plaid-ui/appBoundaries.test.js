import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitGrep, isComment, scratchRepo, trackedFiles, unmarked } from './src/test/repoGates.js';
import { repoRoot } from './src/test/apps.js';

// The apps do not know each other (memory feedback_apps_dont_know_each_other.md)
// and no app code is written for one service (feedback_no_service_specific_app_code.md).
// Beta review A2 found both rules held by care alone. These two gates hold them.

const APP_DIRS = ['plaid-igt', 'plaid-ud', 'plaid-umr', 'plaid-dict'];
const UI = 'plaid-ui';

// Every crossing that is allowed, with the reason. A new one is a decision,
// made here where it shows.
const ALLOWED = [
  {
    from: 'plaid-dict/',
    to: [
      'plaid-igt/src/domain/vocabFields.js',
      'plaid-igt/src/domain/igtConfig.js',
      'plaid-igt/src/domain/vocabDictionary.js',
      'plaid-igt/src/domain/affixMarkers.js',
      'plaid-igt/src/domain/layerInfo.js',
      'plaid-igt/src/domain/IgtDocument.js',
      'plaid-igt/src/components/vocabularies/FormLabel.jsx',
      'plaid-igt/src/components/projects/search/searchRunner.js',
    ],
    why: 'plaid-dict reads a vocabulary through igt’s own modules (memory plaid_dict_app.md)',
  },
  {
    from: 'plaid-umr/e2e/live/igt-roundtrip.mjs',
    to: ['plaid-igt/'],
    why: 'the UMR and IGT live round trip drives igt’s importers, setup and exports',
  },
  {
    from: 'plaid-umr/test/pickers.test.js',
    to: ['plaid-igt/src/domain/vocabUmr.js'],
    why: 'holds igt’s copy of the concept characters to umr’s until A2-4 moves them into plaid-ui',
  },
  {
    from: 'plaid-ui/tailwindPreset.test.js',
    to: ['plaid-igt/tailwind.config.js', 'plaid-ud/tailwind.config.js'],
    why: 'the shared preset is checked in each app’s resolved config',
  },
];

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.mock\(\s*)['"]([^'"]+)['"]/g;

const packageOf = (rel) => rel.split('/')[0];

/** Where a specifier in `file` lands, repo-relative, or null for a package. */
const target = (file, spec) => {
  const own = packageOf(file);
  if (spec.startsWith('.'))
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  if (spec.startsWith('@igt/')) return `plaid-igt/src/${spec.slice(5)}`;
  if (spec.startsWith('@ui/')) return `${UI}/src/${spec.slice(4)}`;
  if (spec.startsWith('@/')) return `${own}/src/${spec.slice(2)}`;
  return null;
};

/**
 * Each import that crosses from one app into another, or from plaid-ui into
 * an app, and is not allowed, as `file:line -> target`. `files` maps a
 * repo-relative path to its content.
 */
export const crossings = (files) => {
  const found = [];
  for (const [file, content] of Object.entries(files)) {
    const own = packageOf(file);
    if (own !== UI && !APP_DIRS.includes(own)) continue;
    content.split('\n').forEach((line, i) => {
      if (isComment(line)) return;
      for (const m of line.matchAll(SPECIFIER)) {
        const to = target(file, m[1]);
        if (!to) continue;
        const into = packageOf(to);
        if (into === own || !APP_DIRS.includes(into)) continue;
        const ok = ALLOWED.some(
          (a) =>
            file.startsWith(a.from) &&
            a.to.some((t) => (t.endsWith('/') ? to.startsWith(t) : to === t)),
        );
        if (!ok) found.push(`${file}:${i + 1} -> ${to}`);
      }
    });
  }
  return found;
};

// This file's own planted crossings are data, not imports.
const SELF = 'plaid-ui/appBoundaries.test.js';

const trackedSources = (root) =>
  trackedFiles(root, [...APP_DIRS, UI]).filter((f) => /\.(m?js|jsx|cjs)$/.test(f) && f !== SELF);

describe('an app imports no other app', () => {
  it('holds over every app, its tests and e2e, and plaid-ui', () => {
    const root = repoRoot();
    const files = Object.fromEntries(
      trackedSources(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]),
    );
    const found = crossings(files);
    expect(
      found,
      `An app reaches into another app's source, or plaid-ui into an app:\n  ${found.join('\n  ')}\n` +
        'Move what both need into plaid-ui (or plaid-client-js). A crossing that has to stay is a ' +
        'decision: add it to ALLOWED in plaid-ui/appBoundaries.test.js with its reason.',
    ).toEqual([]);
  });

  it('finds a relative path, an alias and a dynamic import, and lets the allowed ones through', () => {
    expect(
      crossings({
        'plaid-ud/src/a.js': "import { x } from '../../plaid-igt/src/domain/igtConfig.js';",
        'plaid-umr/src/b.jsx': "const m = await import('@igt/domain/vocabUmr.js');",
        'plaid-ui/src/c.js': "export { y } from '../../plaid-umr/src/domain/ilg.js';",
        'plaid-dict/src/d.js': "import { z } from '@igt/domain/vocabUmr.js';",
        'plaid-igt/test/e.test.js': "vi.mock('../../plaid-ud/src/f.js');",
        // Allowed, its own, a package, or prose.
        'plaid-dict/src/ok.js': "import { a } from '@igt/domain/vocabFields.js';",
        'plaid-igt/src/own.js':
          "import { b } from '@/domain/igtConfig.js';\nimport { c } from '@ui/lib/x.js';",
        'plaid-ud/src/pkg.js': "import { d } from '@larc-iu/plaid-client';",
        'plaid-ud/src/prose.js': "// once imported from '../../plaid-igt/src/x.js'",
      }),
    ).toEqual([
      'plaid-ud/src/a.js:1 -> plaid-igt/src/domain/igtConfig.js',
      'plaid-umr/src/b.jsx:1 -> plaid-igt/src/domain/vocabUmr.js',
      'plaid-ui/src/c.js:1 -> plaid-umr/src/domain/ilg.js',
      'plaid-dict/src/d.js:1 -> plaid-igt/src/domain/vocabUmr.js',
      'plaid-igt/test/e.test.js:1 -> plaid-ud/src/f.js',
    ]);
  });
});

// --- service ids -------------------------------------------------------------

// The bundled services' ids, read from the services themselves, and the names
// of the tools they wrap, which is how a service is usually named in code.
const SERVICE_WORDS = [
  'cwomp',
  'stanza',
  'polygloss',
  'punkt',
  'whisper',
  'ancast',
  'trankit',
  'udpipe',
];

const bundledServiceIds = (root) =>
  gitGrep(
    root,
    ['(\\bservice_id\\s*=|\\bDEFAULT_SERVICE_ID\\s*=)\\s*[\'"][^\'"]+[\'"]'],
    ['plaid-*/services/*.py', ':!**/tests/**'],
  ).map(({ text }) => /['"]([^'"]+)['"]/.exec(text.split('=').slice(1).join('='))[1]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const APP_SOURCES = [
  ...[...APP_DIRS, UI].map((d) => `${d}/src/**`),
  ':!*.test.*',
  ':!**/src/test/**',
  ':!**/src/data/**',
];

/** Lines naming a service outside a comment, unmarked, as `file:line: text`. */
const namesAService = (root, ids) => {
  const words = [...SERVICE_WORDS, ...ids.map(escape)].join('|');
  const named = new RegExp(words, 'i');
  const hits = gitGrep(root, [`(?i)(${words})`], APP_SOURCES).filter(({ text }) => {
    if (isComment(text)) return false;
    // Not in a comment after the code on the same line.
    return named.test(text.replace(/\s\/\/\s.*$/, '').replace(/\{\/\*.*?\*\/\}/g, ''));
  });
  return unmarked(root, hits, 'service-ok');
};

describe('no app code names a bundled service', () => {
  it('reads every bundled service’s id', () => {
    const ids = bundledServiceIds(repoRoot());
    expect(ids).toEqual(expect.arrayContaining(['stanza-parser', 'cwomp-analyzer', 'umr-ancast']));
  });

  it('holds over every app and plaid-ui', () => {
    const root = repoRoot();
    const found = namesAService(root, bundledServiceIds(root));
    expect(
      found,
      `App code names a service:\n  ${found.join('\n  ')}\n` +
        'Key on what a service declares (its task, its parameters, the provenance it writes), never on ' +
        'which service it is (memory feedback_no_service_specific_app_code.md). Copy that only names ' +
        'one, as an example, says so on the line or the line above: `// service-ok: <reason>`.',
    ).toEqual([]);
  });

  it('finds an id or a tool’s name in code and copy, and lets comments and marked lines through', () => {
    const root = scratchRepo({
      'plaid-x/services/x_parse.py': "        service_id='x-parser',\n",
      'plaid-igt/src/bad.js': [
        "if (service.id === 'x-parser') run();",
        "const label = 'Stanza';",
        "if (s.serviceId === 'cwomp-analyzer') x(); // the CWoMP one",
        '',
      ].join('\n'),
      'plaid-ui/src/clean.jsx': [
        '// Stanza writes these, as any parser may.',
        ' * x-parser',
        'const tasks = s.tasks; // a whisper of a task',
        '{/* service-ok: an example a person types */}',
        '<Input placeholder="e.g. Stanza parser" />',
        '',
      ].join('\n'),
      'plaid-igt/src/bad.test.js': "if (service.id === 'x-parser') run();\n",
    });
    const ids = bundledServiceIds(root);
    expect(ids).toEqual(['x-parser']);
    expect(namesAService(root, ids).map((r) => r.split(':').slice(0, 2).join(':'))).toEqual([
      'plaid-igt/src/bad.js:1',
      'plaid-igt/src/bad.js:2',
      'plaid-igt/src/bad.js:3',
    ]);
  });
});
