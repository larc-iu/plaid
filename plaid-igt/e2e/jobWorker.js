import { randomUUID } from 'node:crypto';

// A job worker the spec drives by hand: the JS client as the e2e admin (the
// worker's routes are an admin's), claiming a job and moving it on the way
// plaid-agent's worker does, with no model. Each call is one step the spec
// asks for, so the spec decides when the job moves and checks the app between.
export function fakeJobWorker(client, { model = 'e2e-scripted' } = {}) {
  const workerId = randomUUID();
  return {
    workerId,
    // The oldest job waiting on the server, now running, or null.
    claim: async () => (await client.jobs.claim(workerId, { model, apps: ['igt'] }))?.job ?? null,
    // `{phase, message, waitingFor, currentDocument}`: what the banner and the
    // job page show. Answers `{state, token, leaseS}`.
    heartbeat: (jobId, fields) => client.jobs.heartbeat(jobId, workerId, fields),
    // One document row: its state, sentences, targets, done, counts, skipped.
    document: (jobId, documentId, fields) =>
      client.jobs.updateDocument(jobId, documentId, workerId, fields),
    finish: (jobId, { state, reason, report }) =>
      client.jobs.finish(jobId, workerId, { state, reason, report }),
  };
}

// A report in the shape the worker writes (CONTRACT 5.3), for a job that
// worked in one document and was stopped.
export const stoppedReport = ({ instructions, document, startedAt }) => ({
  state: 'cancelled',
  reason: 'cancelled',
  instructions,
  startedBy: null,
  model: 'e2e-scripted',
  startedAt,
  finishedAt: new Date().toISOString(),
  pausedForPeopleS: 0,
  pausedForModelS: 0,
  stopped: null,
  totals: {
    documentsDone: 0,
    documentsInUse: 0,
    documentsGone: 0,
    documentsNotReached: 1,
    sentences: 5,
    translations: 0,
    refreshed: 0,
    words: 12,
    links: 0,
    entries: 0,
    skippedTooLong: 1,
    skippedFailed: 0,
    skippedChanged: 0,
    changed: 0,
    proposed: 0,
  },
  documents: [
    {
      documentId: document.id,
      name: document.name,
      state: 'not-reached',
      sentences: 10,
      targets: 10,
      done: 5,
      counts: { words: 12 },
      skipped: [
        { sentence: 's3', sentenceId: document.sentenceId, reason: 'too-long', kind: null },
      ],
      glossGroup: null,
      harmonizeGroup: null,
    },
  ],
  harmonize: { changed: [], left: [], changedMore: 0, leftMore: 0 },
  entries: {
    created: [],
    deleted: [],
    unlinked: [],
    createdMore: 0,
    deletedMore: 0,
    unlinkedMore: 0,
    lexicons: [],
  },
});
