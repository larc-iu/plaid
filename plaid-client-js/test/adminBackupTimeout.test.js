// A manual backup answers only once the zip is written, minutes on a large
// database. Under the usual 30 s timeout the page reported "Failed to back
// up" while the backup went on (H7-CORE-OPS-2), so the call waits longer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlaidClient, BACKUP_TIMEOUT_MS } from '../src/index.js';

test('admin.backup waits past the usual timeout', async () => {
  const client = new PlaidClient('http://plaid.test', 't');
  const seen = [];
  client._request = async (method, path, options) => {
    seen.push({ method, path, options });
    return { ok: true };
  };
  await client.admin.backup();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/api/v1/admin/backup');
  assert.equal(seen[0].options.timeout, BACKUP_TIMEOUT_MS);
  assert.ok(BACKUP_TIMEOUT_MS >= 10 * 60 * 1000);
  assert.ok(BACKUP_TIMEOUT_MS > client.timeout);
});
