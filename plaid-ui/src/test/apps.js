import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The apps in this repo, for the tests that judge all of them.
//
// Three tests used to carry a list like this each: the dead-export census, the
// mirrored-stylesheet check and the shared e2e drivers. plaid-umr was added to
// the repo and to none of them, so for two weeks its dead exports were nobody's
// finding, a plaid-ui export written for it alone would have been reported dead
// the moment igt's suite ran, and its canvas was outside the RTL guard. A
// fourth app would land the same way.

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The repo root, found rather than counted: this package is reached through a
 * node_modules symlink, so how many levels up it sits depends on which app's
 * test run this is.
 */
export const repoRoot = () => {
  let dir = here;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'plaid-igt', 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`No repo root above ${here}`);
};

/**
 * The live apps: maintained, released, and held to every rule here. `dir` is
 * the package directory, `tag` the name the apps call each other by (the
 * assistant's `app`, a service's `extras.app`, an e2e driver's harness).
 */
export const APPS = [
  { tag: 'igt', dir: 'plaid-igt' },
  { tag: 'ud', dir: 'plaid-ud' },
  { tag: 'umr', dir: 'plaid-umr' },
];

/** Every app tree of a given kind that exists, as repo-relative paths. */
export const appTrees = (...kinds) => {
  const repo = repoRoot();
  return APPS.flatMap(({ dir }) => kinds.map((k) => `${dir}/${k}`)).filter((tree) =>
    fs.existsSync(path.join(repo, tree)),
  );
};
