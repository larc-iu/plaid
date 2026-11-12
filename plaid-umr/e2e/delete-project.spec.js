import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { deleteProjectTests } from '../../plaid-ui/e2e/deleteProject.js';

// The Delete project confirm in plaid-umr: what it takes is asked with a GET,
// and the project is deleted only on Delete (plaid-ui/e2e/deleteProject.js).

const client = () => new PlaidClient(CORE, readToken().token);

test.describe('Delete project (UMR)', () => {
  deleteProjectTests({
    test,
    expect,
    seedAuth,
    client,
    generalPath: (id) => `/#/projects/${id}/general`,
    suffix: `umr-${process.pid}-${Date.now()}`,
  });
});
