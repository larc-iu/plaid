import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APPS, repoRoot } from './src/test/apps.js';
import { trackedFiles } from './src/test/repoGates.js';

// The list of apps is kept in several places, each right to exist on its own
// (beta review A2-3), and a place an app is missing from fails quietly: its
// projects show as nobody's in the admin listing, its services are not in the
// jar, its pytest step never runs. This reads every roster and says which one
// disagrees.
//
// Two differences are on purpose, and named here:
//  - plaid-dict is bundled, served and run in development, but it is a stale
//    prototype (memory plaid_dict_app.md), so it is not one of the live apps
//    that src/test/apps.js holds to every rule, and no sibling links to it.
//  - the app whose admin area lists everybody's projects (siblingApps.js
//    `adminUrl`) recognises its own projects from its own config, so it is
//    the one live app appOwners.js leaves out.

const PROTOTYPES = ['dict'];

const ROSTER_FILES = {
  pipeline: 'bb/pipeline.clj',
  middleware: 'plaid-core/src/main/plaid/server/middleware.clj',
  siblingApps: 'plaid-ui/src/domain/siblingApps.js',
  appOwners: 'plaid-ui/src/domain/appOwners.js',
};

const all = (re, text) => [...text.matchAll(re)].map((m) => m[1]);
const sorted = (xs) => [...new Set(xs)].sort();
const tagOf = (dir) => dir.replace(/^plaid-/, '');

/** Each roster, read out of its file, as sorted app tags. */
export const readRosters = ({ pipeline, middleware, siblingApps, appOwners }) => {
  const spaDef = /\(def \^:private spa-apps (\[.*\])\)/.exec(pipeline)?.[1] ?? '';
  const spaPairs = [...spaDef.matchAll(/\["(plaid-[\w-]+)" "([\w-]+)"\]/g)];
  const rootsDef =
    /\(def \^:private bundled-spa-roots[\s\S]*?\{([^}]*)\}\)/.exec(middleware)?.[1] ?? '';
  return {
    'bb/pipeline.clj spa-apps': sorted(spaPairs.map((m) => m[2])),
    'bb/pipeline.clj spa-apps directories': sorted(spaPairs.map((m) => tagOf(m[1]))),
    'middleware.clj bundled-spa-roots': sorted(all(/"\/([\w-]+)" "[\w-]+"/g, rootsDef)),
    'middleware.clj landing page': sorted(all(/href=\\"\/([\w-]+)\/\\"/g, middleware)),
    'siblingApps.js': sorted(all(/VITE_(\w+)_URL \|\|/g, siblingApps).map((t) => t.toLowerCase())),
    'siblingApps.js admin area': sorted(
      all(/adminUrl = \(\) => `\$\{(\w+)_URL\}/g, siblingApps).map((t) => t.toLowerCase()),
    ),
    'appOwners.js': sorted(all(/\{\s*tag: '([\w-]+)'/g, appOwners)),
    'bb/pipeline.clj compileall': sorted(
      all(/"plaid-([\w-]+)\/services"/g, /"compileall"[^\n]*\n[^\n]*/.exec(pipeline)?.[0] ?? ''),
    ),
    'bb/pipeline.clj services pytest': sorted(
      all(
        /\{:dir "plaid-([\w-]+)"\} \(python-exe\) "-m" "pytest" "-q" "services\/tests"/g,
        pipeline,
      ),
    ),
    'bb/pipeline.clj services bundle': sorted(
      all(/\(fs\/glob "plaid-([\w-]+)\/services" "\*\.py"\)/g, pipeline),
    ),
  };
};

/** Where the rosters disagree, one line each. */
export const rosterProblems = (rosters, { live, withServices }) => {
  const problems = [];
  const same = (name, want, why) => {
    const got = rosters[name];
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${name} has [${got.join(', ')}], expected [${want.join(', ')}] (${why})`);
  };
  const bundled = sorted([...live, ...PROTOTYPES]);
  const why = 'the live apps of src/test/apps.js and the prototypes';
  same('bb/pipeline.clj spa-apps', bundled, why);
  same('bb/pipeline.clj spa-apps directories', bundled, 'each app served under its own tag');
  same('middleware.clj bundled-spa-roots', bundled, why);
  same('middleware.clj landing page', bundled, why);
  same('siblingApps.js', sorted(live), 'the live apps');
  const admin = rosters['siblingApps.js admin area'];
  if (admin.length !== 1 || !live.includes(admin[0]))
    problems.push(`siblingApps.js adminUrl names [${admin.join(', ')}], expected one live app`);
  else
    same(
      'appOwners.js',
      sorted(live.filter((t) => t !== admin[0])),
      'the live apps but the admin area’s own',
    );
  const services = 'the apps with services/*.py';
  same('bb/pipeline.clj compileall', sorted(withServices), services);
  same('bb/pipeline.clj services pytest', sorted(withServices), services);
  same('bb/pipeline.clj services bundle', sorted(withServices), services);
  return problems;
};

const appsWithServices = (root) =>
  sorted(
    trackedFiles(root, ['plaid-*/services/*.py'])
      .filter((f) => /^plaid-[\w-]+\/services\/[^/]+\.py$/.test(f))
      .map((f) => tagOf(f.split('/')[0])),
  );

const readSources = (root) =>
  Object.fromEntries(
    Object.entries(ROSTER_FILES).map(([k, f]) => [k, fs.readFileSync(path.join(root, f), 'utf8')]),
  );

describe('every list of the apps agrees', () => {
  it('holds over the rosters', () => {
    const root = repoRoot();
    const problems = rosterProblems(readRosters(readSources(root)), {
      live: APPS.map((a) => a.tag),
      withServices: appsWithServices(root),
    });
    expect(
      problems,
      `The lists of apps disagree:\n  ${problems.join('\n  ')}\n` +
        'Adding, renaming or dropping an app means every one of these: bb/pipeline.clj (spa-apps, the ' +
        'services compileall, pytest step and bundle glob), plaid-core middleware.clj (bundled-spa-roots ' +
        'and the landing page), plaid-ui siblingApps.js, appOwners.js and src/test/apps.js. ' +
        'A difference that is on purpose goes in plaid-ui/appRoster.test.js with its reason.',
    ).toEqual([]);
  });

  it('reads each roster, and names the one an app is missing from', () => {
    const root = repoRoot();
    const sources = readSources(root);
    const rosters = readRosters(sources);
    // Every roster read something: a pattern that stopped matching would
    // otherwise read as an empty list agreeing with nothing, loudly, but for
    // the wrong reason.
    for (const [name, tags] of Object.entries(rosters))
      expect(tags.length, name).toBeGreaterThan(0);

    const planted = {
      ...sources,
      middleware: sources.middleware.replace('"/umr" "umr"', ''),
      appOwners: sources.appOwners.replace(/\{\s*tag: 'umr'[^\n]*\n/, ''),
    };
    const problems = rosterProblems(readRosters(planted), {
      live: APPS.map((a) => a.tag),
      withServices: [...appsWithServices(root), 'dict'],
    });
    expect(problems.map((p) => p.split(' has ')[0])).toEqual([
      'middleware.clj bundled-spa-roots',
      'appOwners.js',
      'bb/pipeline.clj compileall',
      'bb/pipeline.clj services pytest',
      'bb/pipeline.clj services bundle',
    ]);
  });
});
