import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { deleteProjectTests } from '../../plaid-ui/e2e/deleteProject.js';

// The Delete project confirm in plaid-ud: what it takes is asked with a GET,
// and the project is deleted only on Delete (plaid-ui/e2e/deleteProject.js).

const client = () => new PlaidClient(CORE, readToken().token);

test.describe('Delete project (UD)', () => {
  deleteProjectTests({
    test,
    expect,
    seedAuth,
    client,
    generalPath: (id) => `/#/projects/${id}/general`,
    suffix: `ud-${process.pid}-${Date.now()}`,
  });
});
