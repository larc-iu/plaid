import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appTrees, repoRoot } from '../../test/apps.js';

// H10-SCRIPTS-2: an address with a letter outside ASCII before the `@`
// (`müller@x.de`) or in its domain (`a@bücher.de`) is a valid user id, and
// core takes it. A browser's `type="email"` refuses the first and rewrites the
// second to punycode, so such an account could not sign in, redeem an invite
// or be made from any app. Every address field is a text input with
// `inputMode="email"`, which keeps the phone keyboard and checks nothing.
// Read from the source, since the property is the attribute at each site.

const repo = repoRoot();
const TREES = ['plaid-ui/src', ...appTrees('src'), 'plaid-dict/src'];

const sources = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return sources(full);
        return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
      })
    : [];

const files = TREES.flatMap((t) => sources(path.join(repo, t)));

describe('address fields', () => {
  it('are never type="email"', () => {
    const offences = files.filter((f) => /type=["'{`]+email/.test(fs.readFileSync(f, 'utf8')));
    expect(offences.map((f) => path.relative(repo, f))).toEqual([]);
  });

  it('are text inputs with the email keyboard wherever an address is typed', () => {
    const fields = files.filter((f) => /inputMode="email"/.test(fs.readFileSync(f, 'utf8')));
    expect(fields.map((f) => path.relative(repo, f)).sort()).toEqual([
      'plaid-dict/src/components/auth/LoginForm.jsx',
      'plaid-ui/src/components/auth/LoginForm.jsx',
      'plaid-ui/src/components/auth/RedeemInvite.jsx',
      'plaid-ui/src/components/shared/UserAdminDialogs.jsx',
    ]);
  });
});
