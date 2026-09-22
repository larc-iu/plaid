import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { guidelinesTests } from '../../plaid-ui/e2e/guidelines.js';
import { getFixture } from './fixtureProject.js';

// The Guidelines tab in plaid-umr. Same screen as plaid-igt's and
// plaid-ud's, same tests; this app reaches it by route, as ud does.

const CORE = 'http://localhost:8085';

let projectId;
const client = () => new PlaidClient(CORE, readToken().token);

test.beforeAll(async () => {
  ({ projectId } = await getFixture());
});

test.describe('Guidelines (UMR)', () => {
  guidelinesTests({
    test,
    expect,
    seedAuth,
    client,
    projectId: () => projectId,
    tabPath: (id) => `/#/projects/${id}/guidelines`,
    suffix: `umr-${process.pid}`,
  });
});
