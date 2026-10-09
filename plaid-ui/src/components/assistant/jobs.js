import { notifySuccess, notifyError, notifyWarning } from '../../lib/notify.js';
import { humanizeError, refusalSaid } from '../../lib/errors.js';
import { lastProjects } from './projectReach.js';
import { itemTime } from './itemTime.js';
import { assistantsAmong } from './useAssistantAvailable.js';
import { uuidv4 } from '../../../../plaid-client-js/src/ids.js';

// The assistant's conversations and the runs behind them: what is stored
// where, the page-independent job registry, and asking the service for
// everything that changes a conversation. No React in here.
//
// The assistant service is the only writer of a conversation record
// (plaid_agent/core/ops.py). The page sends a request naming an `op` (send,
// retry, approve, discard, attach, delete, rename, hold) and the tab it comes
// from, and reads the record. The one write the page makes itself is a delete
// when no assistant of this app is online on the project (`deleteOffline`).

// A stream, not a deadline: the service keeps its own budget per turn.
const REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// How long a request that needs no model may say nothing.
const ASK_TIMEOUT_MS = 60 * 1000;

// Said when the page gives up waiting on a request the service is still
// running. The conversation record is where the answer lands, so it is there
// to be picked up.
const LOST_CONTACT =
  'Lost contact with the assistant. It is still working. Reload to pick it back up.';

// Said where a conversation that was deleted elsewhere was asked for.
export const DELETED = 'This conversation was deleted.';

// The record keys carry the app's tag, the same one the service writes
// (plaid_agent/core/conversation.py), so one user's ud: and igt: records
// never collide.
const metaKey = (app, projectId, id) => `${app}:assistant:${projectId}:meta:${id}`;

const convKey = (app, projectId, id) => `${app}:assistant:${projectId}:conv:${id}`;

const metaPrefix = (app, projectId) => `${app}:assistant:${projectId}:meta:`;

const filePrefix = (app, projectId, id) => `${app}:assistant:${projectId}:file:${id}:`;

// Every conversation of this app's, across every project. The project sits in
// the MIDDLE of the key, so no prefix can select the small sidebar entries
// alone: the nearest one also matches each `:conv:` sibling, which is a whole
// transcript apiece. That is what the GLOB on the per-user data list is for
// (plaid-core's sql/user_data.clj says the same thing from the other side).
export const metaGlob = (app) => `${app}:assistant:*:meta:*`;

// Which project a record belongs to, read off its key. The key is where it is
// decided: the record LIVES under that project, so a listed entry is attributed
// from the key rather than from anything written inside it.
export const projectOfKey = (app, key) => {
  const head = `${app}:assistant:`;
  if (typeof key !== 'string' || !key.startsWith(head)) return null;
  const rest = key.slice(head.length);
  const cut = rest.indexOf(':');
  return cut > 0 ? rest.slice(0, cut) : null;
};

// Newest first, by when each conversation was last written to.
const byRecency = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

// The sidebar entries, newest first. `allProjects` widens the read from this
// project to every one of them, for a reader looking for a thread whose
// project they have forgotten. Each entry carries the project it belongs to,
// so a row can say so and link there.
//
// The store pages, at the client's default of 100 entries a request, and every
// page is read: the server orders by key and the sidebar orders by recency, so
// a single page would be an arbitrary hundred rather than the newest hundred.
export const readMetas = async (store, { allProjects = false } = {}) => {
  const { client, userId, app, projectId } = store;
  if (!userId) return [];
  const entries = await client.userData.list(
    userId,
    allProjects
      ? { pattern: metaGlob(app), includeValues: true }
      : { prefix: metaPrefix(app, projectId), includeValues: true },
  );
  return (entries || [])
    .map((e) => {
      const meta = e.value;
      if (!meta || !meta.id) return null;
      return { ...meta, projectId: projectOfKey(app, e.key) || projectId };
    })
    .filter(Boolean)
    .sort(byRecency);
};

// A UUID: request ids must be one (the server checks), and conversation ids
// share the generator.
const newId = uuidv4;

// --- work that outlives the component ------------------------------------------
// A request's stream can run for minutes, and meanwhile the user may switch
// tabs (which unmounts this component) or a dev reload may remount it. So a
// job runs here, at module level, and the component only subscribes to
// whatever is in flight for the conversation it shows. A job is {id (the
// conversation), projectId, serviceId, kind: 'turn' | 'apply', requestId,
// planId, conv, controller, progress, steps, stopping, stopped, error,
// outcome, done, result}. At most one job runs per conversation.
//
// The registry lives on globalThis rather than in this module's scope, so a
// hot update of this file in development (which re-evaluates the module
// while a job may be running) finds the same maps instead of empty ones.
const registry = (globalThis.__plaidAssistantJobs ??= {
  serviceCache: new Map(), // project id -> services, so a remount need not blank the picker
  jobs: new Map(), // conversation id -> job in flight
  jobListeners: new Set(), // mounted components
  lastOpen: new Map(), // project id -> the conversation shown when the tab was last left
});
export const { serviceCache, jobs, jobListeners, lastOpen } = registry;

export const jobFor = (id) => (id ? jobs.get(id) || null : null);

const notifyJob = (j) => jobListeners.forEach((fn) => fn(j));

// An entry, back in its place in the list. SORTED rather than moved to the
// front: opening a conversation re-reads its record without changing it, and
// hoisting it there moved every other row under the pointer that had just
// clicked one.
export const upsert = (meta) => (prev) =>
  meta?.id ? [meta, ...prev.filter((m) => m.id !== meta.id)].sort(byRecency) : prev;

// The record as the server has it. A key that is gone reads as a 404, which
// the caller takes as the conversation deleted.
export const readConv = async (store, id) => {
  const { client, userId, app, projectId } = store;
  const [c, m] = await Promise.all([
    client.userData.get(userId, convKey(app, projectId, id)),
    client.userData.get(userId, metaKey(app, projectId, id)),
  ]);
  const v = c?.value || {};
  return {
    conv: { id, messages: v.messages || [], display: v.display || [] },
    // Under this project's keys is the only place it was looked for, so that is
    // the project it belongs to. The entry goes back into the list as it is,
    // and a row there has to know its own project.
    meta: m?.value ? { ...m.value, projectId } : null,
  };
};

// The sidebar entry alone, small, for a check on a conversation on screen.
// Null when it is gone.
export const readMeta = async (store, id) => {
  const { client, userId, app, projectId } = store;
  try {
    const m = await client.userData.get(userId, metaKey(app, projectId, id));
    return m?.value ? { ...m.value, projectId } : null;
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
};

// --- requests that need no model --------------------------------------------------

// Ask the service for an op on a conversation (plaid_agent/core/ops.py).
// Resolves to `{kind: 'done', meta}` or `{kind: 'refused', why, message,
// meta}`, where `message` is the sentence to show. A refusal is a result, not
// an error. The request is its own action: it carries no open operation.
export const ask = (store, service, convId, op, fields = {}, { tab = null } = {}) => {
  const { client, projectId } = store;
  return client.messages.requestService(
    projectId,
    service.serviceId,
    { projectId, conversationId: convId, tab, op, ...fields },
    ASK_TIMEOUT_MS,
    undefined,
    undefined,
    { requestId: newId(), noOperation: true },
  );
};

// The entry a request's result names, with its project, or null.
export const metaOf = (store, result) =>
  result?.meta ? { ...result.meta, projectId: store.projectId } : null;

// Delete one conversation. The service does it (it stops a turn running there
// first, and refuses while an approval runs). With no assistant of this app
// online on the conversation's project, the page deletes it itself, the one
// write it makes (Luke's ruling, 2026-10-09): files first, then the
// transcript, then the entry, so a delete cut short still lists.
//
// The keys are the ROW's OWN project: a row listed from another project is
// deleted under that project's keys.
export const deleteConversation = async (store, meta, { tab = null } = {}) => {
  const { client, app } = store;
  const own = { ...store, projectId: meta.projectId };
  const found = await client.messages.discoverServices(meta.projectId);
  const online = assistantsAmong(found, app);
  const service = online.find((s) => s.serviceId === meta.serviceId) ?? online[0] ?? null;
  if (!service) return deleteOffline(own, meta.id);
  const result = await ask(own, service, meta.id, 'delete', {}, { tab });
  if (result?.kind === 'refused') throw Object.assign(new Error(result.message), { refused: true });
  return result;
};

const deleteOffline = async (store, id) => {
  const { client, userId, app, projectId } = store;
  const files = await client.userData.list(userId, {
    prefix: filePrefix(app, projectId, id),
    pageSize: 1000,
  });
  const gone = (e) => {
    if (e?.status !== 404) throw e;
  };
  for (const e of files || []) await client.userData.delete(userId, e.key).catch(gone);
  await client.userData.delete(userId, convKey(app, projectId, id)).catch(gone);
  await client.userData.delete(userId, metaKey(app, projectId, id)).catch(gone);
};

// --- turns and approvals -----------------------------------------------------------

// A marker naming a request a page can rejoin (a turn or an approval).
export const followable = (p) => (p?.requestId && p.kind !== 'discard' ? p : null);

// A progress event carries the reply text written so far (`text`), whole
// each time; the step list keeps only what the assistant did between them.
// `recorded` says the service has the message in the record.
const progressOf = (j) => (p) => {
  const msg = p?.message || '';
  j.progress = msg;
  if (typeof p?.text === 'string') j.partial = p.text;
  if (p?.recorded) {
    j.recorded = true;
    j.unsent = null;
    if (j.onRecorded) j.onRecorded();
  }
  if (
    msg &&
    !/^(Thinking|Done|Planning|Planned|Applying|Writing)/.test(msg) &&
    j.steps[j.steps.length - 1] !== msg
  ) {
    j.steps = [...j.steps, msg];
  }
  notifyJob(j);
};

// Run a request stream to its end, recording how it ended on the job.
const watch = async (j, run) => {
  try {
    j.outcome = await run();
  } catch (e) {
    if (e?.name === 'AbortError') j.stopped = true;
    else {
      j.error = e;
      if (e?.status !== 404) console.error('[Assistant] request failed', e);
    }
  }
};

// An answer the record could not take (`warning` and the whole `item` on the
// turn's result), shown once after the record as stored, flagged `unsaved`
// with the line that says so. Never written: the service stored what stands
// in for it, or will store it once the server answers.
// Its plan stays out: approving needs it in the record, where the service
// reads it.
const withUnsavedAnswer = (conv, outcome) => {
  // eslint-disable-next-line no-unused-vars
  const { plan, ...answer } = outcome.item;
  return {
    ...conv,
    display: [
      ...conv.display.filter((d) => !(d.kind === 'error' && d.text === outcome.warning)),
      { ...answer, unsaved: true, createdAt: answer.createdAt || itemTime() },
      { kind: 'error', unsaved: true, text: outcome.warning, createdAt: itemTime() },
    ],
  };
};

// However a job's stream ended, the record is the outcome: read it back. A
// conversation deleted meanwhile reads as gone. A refusal is said above the
// composer (`why`), and a message the record never took goes back to it
// (`unsent`).
const finishJob = async (j, store) => {
  const refused = j.outcome?.kind === 'refused' ? j.outcome : null;
  if (refused) {
    j.declined = true;
    j.why = refused.message;
    j.gone = refused.why === 'gone';
    j.held = refused.why === 'held';
  }
  if (j.error?.pending === true && j.kind === 'turn') notifyWarning(LOST_CONTACT, 'Assistant');
  let result;
  try {
    result = await readConv(store, j.id);
  } catch (e) {
    if (e?.status !== 404) console.error('[Assistant] could not read the conversation back', e);
    if (e?.status === 404 && j.create && !j.recorded && !j.gone) {
      // A first message the service never took: the conversation was never
      // made, and is a new one again, its text back in the composer.
      result = { conv: { id: j.id, messages: [], display: [], draft: true }, meta: null };
    } else if (e?.status === 404 || j.gone) {
      j.gone = true;
      j.why = DELETED;
      // The conversation as it was shown, without the message that was not
      // taken.
      const shown = j.conv;
      result = {
        conv:
          j.kind === 'turn' && j.asked
            ? { ...shown, display: shown.display.filter((d) => d !== j.asked) }
            : shown,
        meta: null,
      };
    } else {
      result = { conv: j.conv, meta: null };
    }
  }
  // The request is over and the record still names it: the service that ran
  // it went away. Any op on the conversation has the service settle what it
  // left (a turn's marker cleared, an approval's plan marked interrupted, so
  // its card offers Apply again), and a hold is the one that changes nothing
  // else. A request this page only lost contact with is still running.
  if (
    result.meta?.pending?.requestId === j.requestId &&
    !j.error?.pending &&
    j.tab &&
    j.serviceId
  ) {
    try {
      await ask(store, { serviceId: j.serviceId }, j.id, 'hold', {}, { tab: j.tab });
      result = await readConv(store, j.id);
    } catch {
      // Not answered now: the next look at the conversation asks again.
    }
  }
  if (j.kind === 'turn' && j.outcome?.kind === 'turn' && j.outcome.item && j.outcome.warning) {
    result = { ...result, conv: withUnsavedAnswer(result.conv, j.outcome) };
  }
  // A send the record never took: the text goes back to the composer.
  if (j.recorded) j.unsent = null;
  j.done = true;
  j.result = result;
  notifyJob(j);
  jobs.delete(j.id);
  notifyJob(j);
  return result;
};

// `startedAt` (ms) is when the request was made, which is what the turn's
// clock counts from. A job rejoined after a reload takes it from the record,
// or the clock would start again at 0:00 on every load.
const newJob = (fields) => ({
  controller: new AbortController(),
  startedAt: Date.now(),
  steps: [],
  partial: '',
  stopping: false,
  stopped: false,
  error: null,
  outcome: null,
  done: false,
  result: null,
  recorded: false,
  ...fields,
});

// Where the conversation BEGAN, as the sidebar entry stores it: the field name
// IS the kind, so `{documentId, documentName}` beside a document and
// `{lexiconId, lexiconName}` beside a vocabulary. The service writes it on the
// first turn (`ops.about_of`); the page draws the new row with it at once.
export const aboutOf = (where) =>
  where?.kind && where.id
    ? { [`${where.kind}Id`]: where.id, [`${where.kind}Name`]: where.name ?? null }
    : null;

// Ask the service to answer a message. `conv` is the page's copy with the
// message shown at its end (`asked`, a send), or as it stands (a retry, whose
// rewind the service makes). The service appends the message and answers it;
// the request reports `recorded` once the message is in the record, and until
// then the text is the composer's (`unsent`).
export const startTurn = ({
  store,
  service,
  conv,
  where = null,
  text = null,
  files = [],
  projects = [],
  create = false,
  retry = false,
  tab = null,
}) => {
  const { client, projectId } = store;
  const requestId = newId();
  const asked = retry ? null : conv.display.at(-1);
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'turn',
    requestId,
    planId: null,
    conv,
    asked,
    tab,
    create,
    unsent: retry ? null : text,
    progress: 'Thinking…',
  });
  // A retry is drawn from the record once the service has rewound it.
  if (retry) {
    j.onRecorded = () =>
      readConv(store, conv.id)
        .then((read) => {
          if (j.done) return;
          j.conv = read.conv;
          j.rebased = true;
          notifyJob(j);
        })
        .catch(() => {});
  }
  jobs.set(conv.id, j);
  j.promise = (async () => {
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        // `where` is the LIVE location, sent fresh with every turn, and not
        // `about`, which is where the conversation began and never changes.
        // The panel outlives the screen it was opened from, so a reader can
        // walk from one document to another with the same thread open.
        {
          projectId,
          conversationId: conv.id,
          tab,
          op: retry ? 'retry' : 'send',
          ...(retry
            ? {}
            : {
                text,
                create,
                ...(where ? { where } : {}),
                ...(files.length ? { files } : {}),
                ...(projects.length ? { projects } : {}),
              }),
        },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
        // The other projects the message reads. The server scopes the token it
        // hands the assistant to this project and those of these the reader
        // can open, so a turn reaches nothing else.
        //
        // `noOperation`: a turn is its own action. The client holds one open
        // operation, and an edit still saving would otherwise take it in.
        {
          requestId,
          projectIds: (retry ? lastProjects(conv.display) : projects).map((p) => p.id),
          noOperation: true,
        },
      ),
    );
    // An error the service wrote into the record is shown from there. One
    // that ended the request before the message was taken says why here.
    if (j.error && !j.recorded && j.error.status !== 404 && !j.error.pending) {
      notifyError(refusalSaid(j.error) || humanizeError(j.error, 'The message was not sent.'));
    }
    return finishJob(j, store);
  })();
  return j;
};

// `docked`: the plan card is on screen beside the document, where it turns
// green and says "Applied" in place, under the reader's eyes. A toast saying
// the same thing again is noise, so the success one is left out.
// Only the success one goes: a hard failure leaves the card undecided with no
// inline explanation, so that toast is the only place the reason appears.
export const applyToasts = (j, summary, { docked = false } = {}) => {
  // We stopped waiting, the service did not stop working. Nothing has failed
  // and nothing needs approving again, so say what actually happened.
  if (j.error?.pending) {
    notifyWarning(LOST_CONTACT, 'Assistant');
  } else if (j.outcome?.kind === 'refused') {
    notifyWarning(j.outcome.message, 'Not applied');
  } else if (j.error && j.error.status !== 404) {
    // The reason says what to do next (apply again in a minute, ask for a new
    // plan), so it stays until the reader closes it.
    notifyError(humanizeError(j.error, 'Failed to apply the changes.'), 'Not applied', {
      duration: Infinity,
    });
  } else if (j.outcome?.partial) {
    // The card says it too, but a plan that stopped partway is not something
    // to leave to a glance at the card.
    notifyWarning(j.outcome.message, 'Partly applied');
  } else if (j.outcome?.duplicate) {
    notifyWarning(j.outcome.message, 'Already applied');
  } else if (j.outcome && !docked) {
    notifySuccess(j.outcome.message || `Applied ${summary}.`, 'Changes applied');
  }
};

// Whether a finished job may have changed what the host screen shows, so it
// reloads. A plan that landed did, and so may one that failed partway or lost
// its answer. One refused before it began changed nothing.
export const changesTheView = (j) =>
  !!j.done && j.kind === 'apply' && !j.error?.pending && j.outcome?.kind !== 'refused';

// Apply `plan`. What a plan writes is recorded as verified (made by the
// assistant, confirmed by the approver) unless the user asks for it to count
// as human-made. The service marks the conversation, refuses while other work
// runs there, and settles the plan in the record.
export const startApply = ({ store, service, conv, plan, asHuman, docked = false, tab = null }) => {
  const { client, projectId } = store;
  const requestId = newId();
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'apply',
    requestId,
    planId: plan.id,
    conv,
    tab,
    progress: 'Applying changes…',
  });
  jobs.set(conv.id, j);
  j.promise = (async () => {
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        { projectId, conversationId: conv.id, tab, op: 'approve', planId: plan.id, asHuman },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        undefined,
        // Approving is its own action, applied as one assistant-plan
        // operation the service opens.
        { requestId, noOperation: true },
      ),
    );
    if (j.outcome?.kind !== 'refused' || j.outcome.why !== 'gone') {
      applyToasts(j, plan.summary, { docked });
    }
    return finishJob(j, store);
  })();
  return j;
};

// Whether some of an undecided plan's changes may be in the project: its
// approval was interrupted after the run marked it as writing (the service
// does so before it sends the first change, `plan.WRITING` in plaid-agent).
// Such a plan cannot be discarded: applying it again finishes it.
export const mayHaveWritten = (item) =>
  !!item?.plan && item.status == null && !!item.interrupted && !!item.plan.writing;

// Whether such a plan's documents show that its run wrote nothing after all,
// so the card offers Discard (the service checks it again when asked,
// `plan.nothing_landed`). Each document the run held is still at the version
// it held it at, and every change lands in those documents (`inside`). False
// whenever that cannot be told.
export const nothingLanded = async (store, item) => {
  if (!mayHaveWritten(item) || item.plan.writing?.inside !== true) return false;
  const held = (item.plan.documents || []).filter((d) => d?.id && d.heldFrom != null);
  if (!held.length) return false;
  try {
    const now = await Promise.all(held.map((d) => store.client.documents.get(d.id)));
    return now.every((doc, i) => doc?.version === held[i].heldFrom);
  } catch {
    return false;
  }
};

// Rejoin the request a conversation's record says is under way (it was
// submitted from a page that is gone, or from another tab). The record gets
// the outcome either way; this is for showing progress and refreshing when it
// lands. A request the server no longer knows (404) is over: the service is
// asked to settle what it left (`finishJob`), and the record then shows the
// question unanswered with Retry, or the plan Not finished. `tab` is the tab
// asking.
export const attachJob = ({ store, conv, meta, docked = false, tab = null }) => {
  const { client, projectId } = store;
  const p = meta.pending;
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: p.serviceId || null,
    kind: p.kind === 'apply' ? 'apply' : 'turn',
    requestId: p.requestId,
    planId: p.planId || null,
    conv,
    recorded: true,
    attached: true,
    tab,
    progress: p.kind === 'apply' ? 'Applying changes…' : 'Thinking…',
    startedAt: Date.parse(p.startedAt) || Date.now(),
  });
  jobs.set(conv.id, j);
  j.promise = (async () => {
    await watch(j, () =>
      client.messages.attachServiceRequest(
        projectId,
        p.requestId,
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
      ),
    );
    if (j.kind === 'apply' && j.error?.status !== 404) {
      const plan = conv.display.find((d) => d.plan?.id === j.planId)?.plan;
      applyToasts(j, plan?.summary || 'the changes', { docked });
    }
    return finishJob(j, store);
  })();
  return j;
};

// Ask the service to stop a turn. It stops between steps and records it; if
// the request is already gone, end our side.
export const stopJob = async (client, projectId, j) => {
  if (!j || j.kind !== 'turn' || j.stopping || j.done) return;
  j.stopping = true;
  j.progress = 'Stopping…';
  notifyJob(j);
  try {
    await client.messages.cancelServiceRequest(projectId, j.requestId);
  } catch (e) {
    if (e?.status === 404) j.controller.abort();
    // 409: it just finished; the stream delivers the result.
  }
};

// A conversation that has not been sent yet. It gets its id up front so it can
// sit in the sidebar like any other, and the service creates it with the
// first message (`create`).
export const newConversation = () => ({
  id: newId(),
  messages: [],
  display: [],
  draft: true,
});
