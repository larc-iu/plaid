import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { getFixture } from './fixtureProject.js';
import { guidelinesTests } from '../../plaid-ui/e2e/guidelines.js';

// The Guidelines tab in plaid-igt. The screen is one component in plaid-ui and
// so are the tests that are about it; what this file supplies is where this app
// serves the tab (a `?tab=`) and which project to put them on.

let projectId;
const client = () => new PlaidClient(CORE, readToken().token);

test.beforeAll(async () => {
  ({ projectId } = await getFixture());
});

test.describe('Guidelines (IGT)', () => {
  guidelinesTests({
    test,
    expect,
    seedAuth,
    client,
    projectId: () => projectId,
    tabPath: (id) => `/#/projects/${id}?tab=guidelines`,
    // Titles are unique per project and the fixture is shared, so a run brands
    // its own and afterAll takes them away again.
    suffix: `igt-${process.pid}`,
  });
});
