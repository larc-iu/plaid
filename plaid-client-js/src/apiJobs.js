/**
 * The jobs bundle: unattended assistant jobs (the core manual, "Jobs"). A
 * writer starts a job on a project, and one worker process, run by the
 * operator under an admin account, takes jobs one at a time and writes as the
 * person who started each. The bundle has the people's calls (create, list,
 * get, active, cancel, worker) and the worker's (claim, heartbeat,
 * updateDocument, finish, the decisions, modelBusy). The twin of
 * plaid-client-py's JobsResource.
 *
 * Jobs are not audited, so no call here joins an open logical operation. The
 * worker's calls are signals (`outOfBand`): made on a batch they still go over
 * the wire, and none carries an Idempotency-Key, since core never replays
 * them.
 */

import { bodyOf } from "./families.js";
import { iterPages, listAll, listPage } from "./pagination.js";

/**
 * @typedef {import("./types.js").Job} Job
 * @typedef {import("./types.js").JobDocument} JobDocument
 * @typedef {import("./types.js").JobDocumentFields} JobDocumentFields
 * @typedef {import("./types.js").JobReport} JobReport
 * @typedef {import("./types.js").JobDecision} JobDecision
 * @typedef {import("./types.js").JobDecisionRow} JobDecisionRow
 */

/**
 * @template [T=any]
 * @typedef {import("./types.js").Page<T>} Page
 */

/** A 204 answer (no body) as null, any other as it came. */
const orNull = (answer) => (answer === "" || answer === undefined ? null : answer);

/** @param {import("./client.js").PlaidClient} client */
export function jobsApi(client) {
  return {
    /**
     * Start a job on a project. Needs a writer of the project, and a person's
     * own token: a delegated token is refused (403). The job waits until a
     * worker takes it. Refused with 409 `job-active` (the error's
     * `responseData.job` names it) while the project has a job waiting or
     * running, and with 400 for an unknown app, no task, `link` without
     * `gloss`, a document of another project, more than 500 documents, or a
     * note over 2,000 characters.
     * @param {string} projectId - The project
     * @param {object} job
     * @param {string} job.app - The app whose tasks it runs: `igt`
     * @param {string[]} job.tasks - Some of `translate`, `gloss`, `link` (`link` needs `gloss`)
     * @param {string[]} [job.documents] - The documents, in order. Left out: every document of the project, by name
     * @param {string} [job.note] - Instructions sent with every stretch of the job (at most 2,000 characters)
     * @param {string} [job.id] - The new job's id, minted by the caller (see uuidv7)
     * @returns {Promise<Job>}
     */
    create: (projectId, { app, tasks, documents, note, id } = {}) =>
      client._request("POST", `/api/v1/projects/${projectId}/jobs`, {
        // A job is not audited, so it never joins an open operation, and
        // never takes a number from an edit's Idempotency-Key seed.
        noOperation: true,
        body: bodyOf({ id, app, tasks, documents, note }),
      }),
    /**
     * A project's jobs, newest first, each without its documents and report
     * and with `documentCount`, how many documents it holds. Transparently follows pagination cursors and returns the full flat
     * array. Any reader of the project.
     * @param {string} projectId - The project
     * @returns {Promise<Job[]>}
     */
    list: (projectId) => listAll(client, `/api/v1/projects/${projectId}/jobs`),
    /**
     * One page of a project's jobs, newest first, each with `documentCount`
     * in place of its documents.
     * @param {string} projectId - The project
     * @param {object} [opts]
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<Job>>}
     */
    listPage: (projectId, { limit, cursor } = {}) =>
      listPage(client, `/api/v1/projects/${projectId}/jobs`, { limit, cursor }),
    /**
     * Async-iterate a project's jobs page by page, newest first; yields each
     * page's entries array.
     * @param {string} projectId - The project
     * @param {object} [opts]
     * @param {number} [opts.pageSize] - Per-request page size
     * @returns {AsyncGenerator<Job[]>}
     */
    iterPages: (projectId, { pageSize } = {}) =>
      iterPages(client, `/api/v1/projects/${projectId}/jobs`, { pageSize }),
    /**
     * Read one job, with its documents (in the job's order) and, once it has
     * ended, its report. Any reader of its project.
     * @param {string} jobId - The job
     * @returns {Promise<Job>}
     */
    get: (jobId) => client._request("GET", `/api/v1/jobs/${jobId}`),
    /**
     * The project's job that is waiting, running or stopping, with its
     * documents and no report, or null when it has none.
     * @param {string} projectId - The project
     * @returns {Promise<Job | null>}
     */
    active: async (projectId) =>
      orNull(await client._request("GET", `/api/v1/projects/${projectId}/jobs/active`)),
    /**
     * Stop a job. Allowed to the person who started it while they still
     * write the project, to a maintainer and to an admin, and never to a
     * delegated token. A waiting job ends at once. A running one is
     * `stopping` until its worker finishes the stretch in flight, or ends at
     * once when no worker holds it. Refused with 409 `job-finished` once it
     * has ended.
     * @param {string} jobId - The job
     * @returns {Promise<Job>}
     */
    cancel: (jobId) =>
      client._request("POST", `/api/v1/jobs/${jobId}/cancel`, { noOperation: true }),
    /**
     * When a job worker last asked for work since core started, and the
     * model it runs: `{seenAt, model, noteMaxChars, documentsMax}`, `seenAt`
     * and `model` null when none has asked. `noteMaxChars` is the longest
     * note a job takes, `documentsMax` the most documents.
     * @returns {Promise<{seenAt: string | null, model: string | null, noteMaxChars: number, documentsMax: number}>}
     */
    worker: () => client._request("GET", "/api/v1/jobs/worker"),
    /**
     * The worker asks for a job. Admin only. Answers the job it now holds,
     * the token to write with (the starter's, scoped to the job's project)
     * and how often to send a heartbeat, or null when no job is waiting or
     * another job holds the server's one slot. The token works while the
     * job runs or stops on this worker, and is refused with 401 `job-ended`
     * once the job ends or another worker takes it.
     * @param {string} workerId - The worker's id, a UUID it minted when it started
     * @param {object} [opts]
     * @param {string} [opts.model] - The model the worker runs
     * @param {string[]} [opts.apps] - The apps whose jobs it takes
     * @returns {Promise<{job: Job, token: string, heartbeatS: number} | null>}
     */
    claim: async (workerId, { model, apps } = {}) =>
      orNull(
        await client._request("POST", "/api/v1/jobs/claim", {
          outOfBand: true,
          body: bodyOf({ "worker-id": workerId, model, apps }),
        }),
      ),
    /**
     * The worker's heartbeat on a job it holds. Admin only. Each key given
     * sets its field, null clears it, and a key left out leaves it. Answers
     * the job's state and a fresh token. Refused with 409 `job-taken` when
     * another worker holds the job, 409 `job-finished` once it has ended, and
     * 409 `job-failed` when its starter no longer writes the project.
     * @param {string} jobId - The job
     * @param {string} workerId - The worker's id
     * @param {object} [fields]
     * @param {string | null} [fields.phase] - `checking`, `glossing`, `harmonizing` or `reporting`
     * @param {string | null} [fields.message] - One line for the person (at most 300 characters)
     * @param {string | null} [fields.waitingFor] - `people` or `model`
     * @param {string | null} [fields.currentDocument] - The document being worked
     * @returns {Promise<{state: string, token: string, leaseS: number}>}
     */
    heartbeat: (jobId, workerId, { phase, message, waitingFor, currentDocument } = {}) =>
      client._request("POST", `/api/v1/jobs/${jobId}/heartbeat`, {
        outOfBand: true,
        body: bodyOf({
          "worker-id": workerId,
          phase,
          message,
          "waiting-for": waitingFor,
          "current-document": currentDocument,
        }),
      }),
    /**
     * The worker sets a document's row of a job it holds. Admin only. Each
     * field given replaces its column and one left out leaves it. Answers the
     * row. 404 for a document the job does not hold.
     * @param {string} jobId - The job
     * @param {string} documentId - The document
     * @param {string} workerId - The worker's id
     * @param {JobDocumentFields} [fields]
     * @returns {Promise<JobDocument>}
     */
    updateDocument: (
      jobId,
      documentId,
      workerId,
      {
        state,
        sentences,
        targets,
        done,
        lastSentence,
        defers,
        counts,
        skipped,
        glossGroup,
        harmonizeGroup,
      } = {},
    ) =>
      client._request("PUT", `/api/v1/jobs/${jobId}/documents/${documentId}`, {
        outOfBand: true,
        body: bodyOf({
          "worker-id": workerId,
          state,
          sentences,
          targets,
          done,
          "last-sentence": lastSentence,
          defers,
          counts,
          skipped,
          "gloss-group": glossGroup,
          "harmonize-group": harmonizeGroup,
        }),
      }),
    /**
     * The worker ends a job it holds and stores its report. Admin only.
     * `done` from running, `cancelled` from stopping, `failed` from running,
     * stopping or a failure core set. Refused with 409 `job-state` otherwise,
     * and 400 for a report over 1,000,000 bytes.
     * @param {string} jobId - The job
     * @param {string} workerId - The worker's id
     * @param {object} end
     * @param {"done" | "cancelled" | "failed"} end.state - How it ended
     * @param {string} [end.reason] - Why, for a failed job (the manual's reason codes)
     * @param {JobReport} end.report - The report
     * @returns {Promise<Job>}
     */
    finish: (jobId, workerId, { state, reason, report } = {}) =>
      client._request("POST", `/api/v1/jobs/${jobId}/finish`, {
        outOfBand: true,
        body: bodyOf({ "worker-id": workerId, state, reason, report }),
      }),
    /**
     * The worker records how it analysed words: each decision's count is
     * added to its row (form and key). Admin only. At most 1,000 a call.
     * @param {string} jobId - The job
     * @param {string} workerId - The worker's id
     * @param {JobDecision[]} decisions - The decisions
     * @returns {Promise<void>}
     */
    addDecisions: async (jobId, workerId, decisions) => {
      await client._request("POST", `/api/v1/jobs/${jobId}/decisions`, {
        outOfBand: true,
        body: { "worker-id": workerId, decisions },
      });
    },
    /**
     * Every decision of a job for these forms, by form, then count from the
     * most, then key. Admin only. 1 to 1,000 forms.
     * @param {string} jobId - The job
     * @param {string[]} forms - The forms, as the worker keys them
     * @returns {Promise<JobDecisionRow[]>}
     */
    lookupDecisions: (jobId, forms) =>
      client._request("POST", `/api/v1/jobs/${jobId}/decisions/lookup`, {
        // A read that travels as a POST, so a form may hold any character.
        outOfBand: true,
        body: { forms },
      }),
    /**
     * Every decision of a job, by form and key. Admin only. Transparently
     * follows pagination cursors and returns the full flat array.
     * @param {string} jobId - The job
     * @returns {Promise<JobDecisionRow[]>}
     */
    decisions: (jobId) => listAll(client, `/api/v1/jobs/${jobId}/decisions`),
    /**
     * How busy a model key is: the requests in flight to live services that
     * declare this `model-pool` in their extras, and when the last of them
     * finished (null when none did in the last 15 minutes). Admin only.
     * @param {string} pool - The pool's name
     * @returns {Promise<{inFlight: number, lastFinishedAt: string | null}>}
     */
    modelBusy: (pool) =>
      client._request("GET", "/api/v1/jobs/model-busy", { queryParams: { pool } }),
  };
}
