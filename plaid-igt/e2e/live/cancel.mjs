// Live check of cooperative cancellation, end to end, without needing any of
// the real services: it stands up a throwaway service that reports progress in
// a loop, asks it to stop mid-run, and asserts the request comes back STOPPED
// rather than failed — and that a `critical` stretch still finishes.
//
//   node e2e/live/cancel.mjs
//
// The service side here is JavaScript; the Python framework is covered by the
// same shape in plaid-client-py's tests plus its own probe.
import { makeClient, getFixtureProjectId } from '../bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const SERVICE_ID = `probe:cancel-${Date.now()}`;

const log = [];
const registration = client.messages.serve(
  projectId,
  { serviceId: SERVICE_ID, serviceName: 'Cancel probe' },
  async (data, helper) => {
    try {
      // A loop that reports progress is already a cancellation checkpoint.
      for (let i = 0; i < 200; i++) {
        helper.progress(i, `step ${i}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      helper.complete({ finished: true });
    } catch (error) {
      if (error?.name !== 'ServiceCancelled') throw error;
      log.push(`threw at the checkpoint after ${log.length ? 'progress' : 'start'}`);
      // The writes must still go through once begun.
      await helper.critical(async () => {
        helper.progress(99, 'committing');
        log.push('critical block ran to completion');
      });
      throw error; // let serve() report it as stopped
    }
  },
  { schemaVersion: 1, tasks: [], summary: 'throwaway' },
);

await new Promise((r) => setTimeout(r, 1500));

let requestId = null;
const result = await client.messages.requestService(
  projectId,
  SERVICE_ID,
  {},
  60000,
  () => {},
  undefined,
  {
    onAccepted: (id) => {
      requestId = id;
      // Let it run a little, then ask it to stop.
      setTimeout(() => client.messages.cancelServiceRequest(projectId, id), 1200);
    },
  },
);

registration.stop();

console.log('request', requestId);
console.log('handler log:', log);
console.log('result:', JSON.stringify(result));
const ok = result?.stopped === true && log.includes('critical block ran to completion');
console.log(ok ? 'PASS: stopped cleanly, critical section finished' : 'FAIL');
process.exit(ok ? 0 : 1);
