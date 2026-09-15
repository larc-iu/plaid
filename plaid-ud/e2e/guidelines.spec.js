import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken } from './fixtures.js';
import { guidelinesTests } from '../../plaid-ui/e2e/guidelines.js';

// The Guidelines tab in plaid-ud. Same screen as plaid-igt's, same tests; this
// app reaches it by route rather than by `?tab=`.

const CORE = 'http://localhost:8085';
const FIXTURE = 'E2E UD Fixture';

let projectId;
const client = () => new PlaidClient(CORE, readToken().token);

test.beforeAll(async () => {
  const project = (await client().projects.list()).find((p) => p.name === FIXTURE);
  if (!project) throw new Error('run node e2e/fixtureProject.js first');
  projectId = project.id;
});

test.describe('Guidelines (UD)', () => {
  guidelinesTests({
    test,
    expect,
    seedAuth,
    client,
    projectId: () => projectId,
    tabPath: (id) => `/#/projects/${id}/guidelines`,
    suffix: `ud-${process.pid}`,
  });
});
