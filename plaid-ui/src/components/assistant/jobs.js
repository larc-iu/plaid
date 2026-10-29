import {
  notifySuccess,
  notifyError,
  notifyWarning,
  notifyInfo,
  dismissToast,
} from '../../lib/notify.js';
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

// What is stored beside a conversation: its files, its rounds and the
// instructions its turns were given (plaid_agent/core/conversation.py BESIDE).
const BESIDE = ['file', 'round', 'prompt'];
const besidePrefix = (app, projectId, id, kind) => `${app}:assistant:${projectId}:${kind}:${id}:`;

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
  return client.messages
    .requestService(
      projectId,
      service.serviceId,
      { projectId, conversationId: convId, tab, op, ...fields },
      ASK_TIMEOUT_MS,
      undefined,
      undefined,
      { requestId: newId(), noOperation: true },
    )
    .catch(async (refused) => {
      const e = await whyRefused(client, projectId, refused);
      if (noteGone(projectId, e)) throw Object.assign(new Error(WENT_OFFLINE), { notLive: true });
      throw e;
    });
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
  const gone = (e) => {
    if (e?.status !== 404) throw e;
  };
  for (const kind of BESIDE) {
    const keys = await client.userData.list(userId, {
      prefix: besidePrefix(app, projectId, id, kind),
      pageSize: 1000,
    });
    for (const e of keys || []) await client.userData.delete(userId, e.key).catch(gone);
  }
  await client.userData.delete(userId, convKey(app, projectId, id)).catch(gone);
  await client.userData.delete(userId, metaKey(app, projectId, id)).catch(gone);
};

// --- turns and approvals -----------------------------------------------------------

// A marker naming a request a page can rejoin (a turn or an approval).
// The channel the tabs of this browser talk on (hold.js).
export const TABS_CHANNEL = 'plaid-assistant';

// Say to the other tabs of this browser that work began on a conversation, so
// one showing it looks at its entry now rather than at its next check.
const tellTabs = (conv) => {
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    const c = new BroadcastChannel(TABS_CHANNEL);
    try {
      c.postMessage({ work: conv });
    } finally {
      c.close();
    }
  } catch {
    // Tabs that cannot hear it look at their next check.
  }
};

export const followable = (p) => (p?.requestId && p.kind !== 'discard' ? p : null);

// A turn's progress event carries the turn so far, whole each time: its steps
// as they will be stored (`trace`, with `stored` on those whose round is
// written), the text of the model call under way (`text`) and the end of its
// reasoning (`thinking`). An approval's
// carries only its message, which the step list keeps.
// `recorded` says the service has the message in the record.
const progressOf = (j) => (p) => {
  const msg = p?.message || '';
  j.progress = msg;
  if (typeof p?.text === 'string') j.partial = p.text;
  if (Array.isArray(p?.trace)) j.trace = p.trace;
  if (typeof p?.thinking === 'string') j.thinking = p.thinking;
  if (p?.recorded) {
    j.recorded = true;
    j.unsent = null;
    if (j.onRecorded) j.onRecorded();
  }
  if (
    j.kind === 'apply' &&
    msg &&
    !/^(Thinking|Done|Planning|Planned|Applying|Writing)/.test(msg) &&
    j.steps[j.steps.length - 1] !== msg
  ) {
    j.steps = [...j.steps, msg];
  }
  notifyJob(j);
};

// An assistant that went away after the page found it: a request to it is
// refused (503, `notLive`), and the panel asks discovery again at once
// (`onAssistantGone`, useAssistantChoice.js) so it says no assistant is online.
const goneListeners = new Set();
export const onAssistantGone = (fn) => {
  goneListeners.add(fn);
  return () => goneListeners.delete(fn);
};
const noteGone = (projectId, e) => {
  if (!e?.notLive) return false;
  for (const fn of [...goneListeners]) fn(projectId);
  return true;
};
const WENT_OFFLINE = 'The assistant went offline.';
const NOT_TAKEN = 'The assistant did not take the request. Try again in a moment.';

// A 503 is the assistant gone only when discovery no longer finds it: the
// server can answer 503 for a moment while it is still there. Answers the
// error to report, its `notLive` kept only when it is gone.
const whyRefused = async (client, projectId, e) => {
  if (!e?.notLive || !client) return e;
  const found = await client.messages.discoverServices(projectId).catch(() => null);
  const there = (found || []).some((s) => s?.serviceId === e.serviceId && s.online !== false);
  if (!there) return e;
  return Object.assign(new Error(NOT_TAKEN), { status: 503, serviceId: e.serviceId });
};

// Run a request stream to its end, recording how it ended on the job.
// `j.client` asks discovery about a 503 (`whyRefused`).
const watch = async (j, run) => {
  try {
    j.outcome = await run();
  } catch (refused) {
    if (refused?.name === 'AbortError') j.stopped = true;
    else {
      const e = await whyRefused(j.client, j.projectId, refused);
      j.error = e;
      noteGone(j.projectId, e);
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
  // left (a turn's marker cleared, an approval's plan settled partly applied,
  // since its changes may be written), and a hold is the one that changes
  // nothing else. A request this page only lost contact with is still running.
  // Asked of the assistant that ran it when it is online, and otherwise of
  // any assistant of this app online on the project, which settles a marker
  // naming one that is not (asking only the one gone was refused every time,
  // and a read-only tab rejoined and asked again every 15 s).
  // Before discovery has answered, the one that ran it.
  const cached = serviceCache.get(store.projectId);
  const online = cached ? assistantsAmong(cached, store.app) : null;
  const settler = online
    ? (online.find((s) => s.serviceId === j.serviceId) ?? online[0] ?? null)
    : j.serviceId
      ? { serviceId: j.serviceId }
      : null;
  if (result.meta?.pending?.requestId === j.requestId && !j.error?.pending && j.tab && settler) {
    try {
      await ask(store, settler, j.id, 'hold', {}, { tab: j.tab });
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
  trace: [],
  partial: '',
  thinking: '',
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
    j.client = client;
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
    if (j.error?.notLive) notifyError(`${WENT_OFFLINE} Nothing was sent.`);
    else if (j.error && !j.recorded && j.error.status !== 404 && !j.error.pending) {
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
// Where the record leaves a plan: its status, or null while it is undecided.
const verdictOf = (item) => item?.status ?? null;

// The "Not applied" error toast of each plan, by plan id, with the verdict
// the record gave the plan when its approval began. It is dismissed once the
// record gives the plan another verdict (`settleApplyToasts`): the card then
// says how the approval ended, so a "Service disconnected" from an assistant
// that died meanwhile is no longer news.
const applyErrorToasts = new Map();
const applyToastId = (planId) => `assistant-apply-error:${planId}`;

export const settleApplyToasts = (display) => {
  for (const d of display || []) {
    const id = d?.plan?.id;
    if (!id || !applyErrorToasts.has(id)) continue;
    const now = verdictOf(d);
    if (now != null && now !== applyErrorToasts.get(id)) {
      applyErrorToasts.delete(id);
      dismissToast(applyToastId(id));
    }
  }
};

// The operation an applied plan is in the audit log, as the service opens
// it (plaid-agent core/service.py `audit_label` and its ref): the app's own
// write of a plan (`writeFirst`) is one of these too, so History names it
// and a study can tie it to its plan.
const AUDIT_LABEL_MAX = 400;
export const planOperation = (convId, plan, serviceId) => {
  const label = Array.from(`Assistant: ${plan?.summary ?? ''}`.replace(/[\u2066-\u2069]/g, ''));
  return {
    message:
      label.length <= AUDIT_LABEL_MAX
        ? label.join('')
        : `${label.slice(0, AUDIT_LABEL_MAX - 1).join('')}…`,
    kind: 'assistant-plan',
    ref: `conv:${convId}/plan:${plan?.id}/service:${serviceId}`,
  };
};

export const WROTE_GONE =
  'The settings were written. The conversation was deleted, so the approval was not recorded.';

export const WROTE_FIRST =
  'The settings were written, but the approval was not recorded. Approve again to record it.';

export const applyToasts = (j, summary, { docked = false } = {}) => {
  // The app wrote its part (settings) and the approval that records it did
  // not go through: what stands is written, and approving again records it.
  if (j.wroteFirst && (j.error || j.outcome?.kind === 'refused') && !j.error?.pending) {
    notifyError(WROTE_FIRST, 'Not recorded', { duration: Infinity });
    return;
  }
  // We stopped waiting, the service did not stop working. Nothing has failed
  // and nothing needs approving again, so say what actually happened.
  if (j.error?.pending) {
    notifyWarning(LOST_CONTACT, 'Assistant');
  } else if (j.outcome?.kind === 'refused') {
    notifyWarning(j.outcome.message, 'Not applied');
  } else if (j.error?.notLive) {
    notifyError(`${WENT_OFFLINE} Nothing was written.`, 'Not applied');
  } else if (j.error && j.error.status !== 404) {
    // The reason says what to do next (apply again in a minute, ask for a new
    // plan), so it stays until the reader closes it.
    const planId = j.planId || null;
    if (planId) {
      const item = j.conv?.display?.find((d) => d.plan?.id === planId);
      applyErrorToasts.set(planId, verdictOf(item));
    }
    notifyError(humanizeError(j.error, 'Failed to apply the changes.'), 'Not applied', {
      duration: Infinity,
      ...(planId ? { id: applyToastId(planId) } : {}),
    });
  } else if (j.outcome?.partial) {
    // The card says it too, but a plan that stopped partway is not something
    // to leave to a glance at the card.
    notifyWarning(j.outcome.message, 'Partly applied');
  } else if (j.outcome?.duplicate) {
    notifyWarning(j.outcome.message, 'Already applied');
  } else if (j.outcome && !docked && j.outcome.applied === 0) {
    // Approved, but what it asked for was already so (settings in force).
    notifyInfo(j.outcome.message, 'Nothing written');
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
// runs there, and settles the plan in the record. `writeFirst` is the app's
// own write for a plan the service may not make with its delegated token
// (settings): made with the user's session before the approval is sent, which
// is not sent when it throws. Before it, the service is asked a preflight
// (`preflight: true`), which runs every check the approval runs and marks the
// plan as the page's to write, with the box as ticked: on
// anything but `ready` nothing is written and the answer is the approval's.
// The approval then says whether the page wrote (`wroteFirst`), so the
// service settles the plan applied whatever landed since the preflight.
export const startApply = ({
  store,
  service,
  conv,
  plan,
  asHuman,
  docked = false,
  tab = null,
  writeFirst = null,
}) => {
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
    j.client = client;
    await watch(j, async () => {
      if (writeFirst) {
        const ready = await client.messages.requestService(
          projectId,
          service.serviceId,
          {
            projectId,
            conversationId: conv.id,
            tab,
            op: 'approve',
            planId: plan.id,
            asHuman,
            preflight: true,
          },
          REQUEST_TIMEOUT_MS,
          undefined,
          undefined,
          { requestId: newId(), noOperation: true },
        );
        if (ready?.kind !== 'ready') return ready;
        try {
          j.wroteFirst = !!(await writeFirst());
        } catch (e) {
          // The preflight marked the plan as written by this page: it was
          // not, so the mark comes off (the service keeps it if the settings
          // read as planned after all). A tab closed here leaves it.
          await client.messages
            .requestService(
              projectId,
              service.serviceId,
              { projectId, conversationId: conv.id, tab, op: 'unmark', planId: plan.id },
              REQUEST_TIMEOUT_MS,
              undefined,
              undefined,
              { requestId: newId(), noOperation: true },
            )
            .catch(() => {});
          throw e;
        }
      }
      return client.messages.requestService(
        projectId,
        service.serviceId,
        {
          projectId,
          conversationId: conv.id,
          tab,
          op: 'approve',
          planId: plan.id,
          asHuman,
          ...(j.wroteFirst ? { wroteFirst: true } : {}),
        },
        REQUEST_TIMEOUT_MS,
        // The first word from the service comes once the record names the
        // approval, which the other tabs then read.
        (p) => {
          if (!j.told) {
            j.told = true;
            tellTabs(conv.id);
          }
          progressOf(j)(p);
        },
        undefined,
        // Approving is its own action, applied as one assistant-plan
        // operation the service opens.
        { requestId, noOperation: true },
      );
    });
    if (j.outcome?.kind !== 'refused' || j.outcome.why !== 'gone') {
      applyToasts(j, plan.summary, { docked });
    } else if (j.wroteFirst) {
      // Deleted between the page's write and its approval: what it wrote stands.
      notifyWarning(WROTE_GONE, 'Not recorded');
    }
    return finishJob(j, store);
  })();
  return j;
};

// Rejoin the request a conversation's record says is under way (it was
// submitted from a page that is gone, or from another tab). The record gets
// the outcome either way; this is for showing progress and refreshing when it
// lands. A request the server no longer knows (404) is over: the service is
// asked to settle what it left (`finishJob`), and the record then shows the
// question unanswered with Retry, or the plan partly applied. `tab` is the tab
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
    tab,
    progress: p.kind === 'apply' ? 'Applying changes…' : 'Thinking…',
    startedAt: Date.parse(p.startedAt) || Date.now(),
  });
  jobs.set(conv.id, j);
  j.promise = (async () => {
    j.client = client;
    await watch(j, () =>
      client.messages.attachServiceRequest(
        projectId,
        p.requestId,
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
      ),
    );
    // A plan the record has already settled is said on its card. Rejoining
    // its stale request after a reload raises nothing.
    const item = conv.display.find((d) => d.plan?.id === j.planId);
    if (j.kind === 'apply' && j.error?.status !== 404 && verdictOf(item) == null) {
      applyToasts(j, item?.plan?.summary || 'the changes', { docked });
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
