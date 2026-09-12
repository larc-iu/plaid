import { notifySuccess, notifyError, notifyWarning } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';

// The assistant's conversations and the runs behind them: what is stored
// where, the page-independent job registry, and starting, watching,
// rejoining, and stopping a run. No React in here.
// A stream, not a deadline: the service keeps its own budget per turn.
export const REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export const TITLE_MAX = 60;

// Said when the page gives up waiting on a request the service is still
// running. The conversation record is where the answer lands, so it is there
// to be picked up.
export const LOST_CONTACT =
  'Lost contact with the assistant. It is still working. Reload to pick it back up.';

// The record keys carry the app's tag, the same one the service writes
// (plaid_agent/core/conversation.py), so one user's ud: and igt: records
// never collide.
export const metaKey = (app, projectId, id) => `${app}:assistant:${projectId}:meta:${id}`;

export const convKey = (app, projectId, id) => `${app}:assistant:${projectId}:conv:${id}`;

export const metaPrefix = (app, projectId) => `${app}:assistant:${projectId}:meta:`;

// A UUID: request ids must be one (the server checks), and conversation ids
// share the generator.
export const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
};

// --- work that outlives the component ------------------------------------------
// A request's stream can run for minutes, and meanwhile the user may switch
// tabs (which unmounts this component) or a dev reload may remount it. So a
// job runs here, at module level, and the component only subscribes to
// whatever is in flight for the conversation it shows. A job is {id (the
// conversation), projectId, serviceId, kind: 'turn' | 'apply', requestId,
// planId, conv, prevMeta, controller, progress, steps, stopping, stopped,
// error, outcome, done, result}. At most one job runs per conversation: the
// composer and the plan's buttons are disabled while one is in flight. A job
// stays in the registry until the record is read back and any settling write
// has landed, so a conversation reopened in that window serves the finished
// copy, and deleting it cannot race the write.
//
// The registry lives on globalThis rather than in this module's scope, so a
// hot update of this file in development (which re-evaluates the module
// while a job may be running) finds the same maps instead of empty ones.
export const registry = (globalThis.__plaidAssistantJobs ??= {
  serviceCache: new Map(), // project id -> services, so a remount need not blank the picker
  saveQueues: new Map(), // conversation id -> Promise (writes in order)
  jobs: new Map(), // conversation id -> job in flight
  jobListeners: new Set(), // mounted components
  lastOpen: new Map(), // project id -> the conversation shown when the tab was last left
});
export const { serviceCache, saveQueues, jobs, jobListeners, lastOpen } = registry;

export const jobFor = (id) => (id ? jobs.get(id) || null : null);

export const notifyJob = (j) => jobListeners.forEach((fn) => fn(j));

export const upsert = (meta) => (prev) => [meta, ...prev.filter((m) => m.id !== meta.id)];

// The sidebar entry after a write. `pending` names the request under way, if
// any: {kind, requestId, serviceId, planId, asHuman, contributedBy, startedAt}.
export const buildMeta = (prev, conv, service, pending = null, about = null) => {
  const firstUser = conv.display.find((d) => d.kind === 'user');
  return {
    id: conv.id,
    title: prev?.title || (firstUser ? titleFrom(firstUser.text) : 'New conversation'),
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceId: service?.serviceId || prev?.serviceId || null,
    model: service?.extras?.model || prev?.model || null,
    turns: conv.display.filter((d) => d.kind === 'user').length,
    // The document the conversation was started from, if any. It is what the
    // tab's list tags a row with, and it never changes once set: a
    // conversation belongs to where it began.
    about: prev?.about || about,
    pending,
  };
};

// Write a conversation (transcript + sidebar entry, or the entry alone).
// Writes for one conversation run one after another so a slow earlier PUT
// cannot land on top of a newer one.
export const persistConv = (store, conv, meta, { metaOnly = false } = {}) => {
  const { client, userId, app, projectId } = store;
  if (!userId) return Promise.resolve();
  const prev = saveQueues.get(conv.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      if (!metaOnly) {
        await client.userData.put(userId, convKey(app, projectId, conv.id), {
          messages: conv.messages,
          display: conv.display,
        });
      }
      await client.userData.put(userId, metaKey(app, projectId, conv.id), meta);
    })
    .catch((e) => {
      console.error('[Assistant] could not save the conversation', e);
      notifyError(humanizeError(e, 'The conversation could not be saved.'));
    })
    .finally(() => {
      // Nothing queued behind this one: stop holding the chain.
      if (saveQueues.get(conv.id) === next) saveQueues.delete(conv.id);
    });
  saveQueues.set(conv.id, next);
  return next;
};

// The record as the server has it. Read after any write of ours has landed.
export const readConv = async (store, id) => {
  const { client, userId, app, projectId } = store;
  await (saveQueues.get(id) || Promise.resolve());
  const [c, m] = await Promise.all([
    client.userData.get(userId, convKey(app, projectId, id)),
    client.userData.get(userId, metaKey(app, projectId, id)),
  ]);
  const v = c?.value || {};
  return {
    conv: { id, messages: v.messages || [], display: v.display || [] },
    meta: m?.value || null,
  };
};

// A plan's outcome decided here (a discard): the status on its card, plus a
// note in the model transcript (user role) so the next turn knows.
export const settle = (conv, index, status, note) => ({
  ...conv,
  messages: note ? [...conv.messages, { role: 'user', content: note }] : conv.messages,
  display: conv.display.map((d, i) => (i === index ? { ...d, status } : d)),
});

// The user's message leaves the model transcript when its turn ends without
// an answer, so a retry does not send it twice; it stays on screen.
export const dropUnanswered = (conv) =>
  conv.messages.at(-1)?.role === 'user' ? conv.messages.slice(0, -1) : conv.messages;

// A progress event carries the reply text written so far (`text`), whole
// each time; the step list keeps only what the assistant did between them.
export const progressOf = (j) => (p) => {
  const msg = p?.message || '';
  j.progress = msg;
  if (typeof p?.text === 'string') j.partial = p.text;
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
export const watch = async (j, run) => {
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

// However a job's stream ended, the record is the outcome: the service wrote
// it before finishing. Read it back; if it still says this request is under
// way, the service never got to write (it or the server went away, or the
// request expired unseen), so settle it here.
//
// Unless the error says the request is STILL OUT THERE (a dropped connection,
// a timeout). Then the service is working and will write the record itself,
// and settling it as failed would both lose the answer when it lands and stop
// the next page from rejoining. Leave it pending and say so.
export const finishJob = async (j, store, service) => {
  let conv;
  let meta;
  try {
    ({ conv, meta } = await readConv(store, j.id));
  } catch (e) {
    console.error('[Assistant] could not read the conversation back', e);
    conv = j.conv;
    meta = buildMeta(j.prevMeta, conv, service);
  }
  const stillOut = j.error?.pending === true;
  if (stillOut && j.kind === 'turn') notifyWarning(LOST_CONTACT, 'Assistant');
  if (!stillOut && meta?.pending?.requestId === j.requestId) {
    if (j.kind === 'turn') {
      if (j.stopped) {
        conv = {
          ...conv,
          messages: dropUnanswered(conv),
          display: [...conv.display, { kind: 'error', stopped: true, text: 'Stopped.' }],
        };
      } else if (j.error && j.error.status !== 404) {
        conv = {
          ...conv,
          messages: dropUnanswered(conv),
          display: [
            ...conv.display,
            { kind: 'error', text: humanizeError(j.error, 'The assistant could not answer.') },
          ],
        };
      }
      // Else the request is simply gone: the message stays unanswered and the
      // tab offers to send it again.
    } else {
      conv = {
        ...conv,
        display: conv.display.map((d) =>
          d.plan?.id === j.planId && d.status === null ? { ...d, interrupted: true } : d,
        ),
      };
    }
    meta = buildMeta(meta, conv, service, null);
    await persistConv(store, conv, meta);
  }
  j.done = true;
  j.result = { conv, meta };
  notifyJob(j);
  jobs.delete(j.id);
  notifyJob(j);
  return j.result;
};

export const newJob = (fields) => ({
  controller: new AbortController(),
  steps: [],
  partial: '',

  stopping: false,
  stopped: false,
  error: null,
  outcome: null,
  done: false,
  result: null,
  ...fields,
});

// Run one turn for `conv`, whose last message is the user's.
//
// `about` is what the screen the turn was sent from is about, as the record
// stores it: `{documentId, documentName}` beside a document, or
// `{lexiconId, lexiconName}` beside a vocabulary. The field name IS the kind,
// because it is also how a panel finds the thread to resume, and a conversation
// written before there were vocabularies has to keep resuming on its document.
export const startTurn = ({ store, service, conv, prevMeta, about = null, where = null }) => {
  const { client, projectId } = store;
  const requestId = newId();
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'turn',
    requestId,
    planId: null,
    conv,
    prevMeta,
    progress: 'Thinking…',
  });
  jobs.set(conv.id, j);
  const meta = buildMeta(
    prevMeta,
    conv,
    service,
    { kind: 'turn', requestId, serviceId: service.serviceId, startedAt: new Date().toISOString() },
    about,
  );
  j.promise = (async () => {
    // The record first: the service reads the message from it, and a tab
    // that comes back finds the request there.
    await persistConv(store, conv, meta);
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        // What is open is a DEFAULT for the turn, not a fence: the service
        // names it in the prompt and leaves every tool in place.
        //
        // `where` is the LIVE location, sent fresh with every turn, and not
        // `about`, which is where the conversation began and never changes.
        // The panel outlives the screen it was opened from, so a reader can
        // walk from one document to another with the same thread open, and
        // every turn after the first would otherwise claim to be about the
        // place they started.
        {
          projectId,
          conversationId: conv.id,
          ...(where ? { where: { kind: where.kind, id: where.id } } : {}),
        },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
        { requestId },
      ),
    );
    return finishJob(j, store, service);
  })();
  return j;
};

// `docked`: the plan card is on screen beside the document, where it turns
// green and says "Applied" in place, under the reader's eyes. A toast saying
// the same thing again is noise, so the success one is left out. (It used to
// be worse than noise: the toaster was bottom-right, which was exactly where
// the docked composer is, so it covered the message the reader was about to
// type. The dock is app chrome now and the toaster steps aside for it, but the
// card still says it better than a toast does.)
// Only the success one goes: a hard failure leaves the card undecided with no
// inline explanation, so that toast is the only place the reason appears.
export const applyToasts = (j, summary, { docked = false } = {}) => {
  // We stopped waiting, the service did not stop working. Nothing has failed
  // and nothing needs approving again, so say what actually happened.
  if (j.error?.pending) {
    notifyWarning(LOST_CONTACT, 'Assistant');
  } else if (j.error && j.error.status !== 404) {
    notifyError(
      humanizeError(j.error, 'The changes could not be applied.') +
        ' Approving again is safe: a plan that was already applied is not written twice.',
      'Not applied',
    );
  } else if (j.outcome && !j.outcome.duplicate && !docked) {
    notifySuccess(j.outcome.message || `Applied ${summary}.`, 'Changes applied');
  }
};

// Apply `plan` from `conv`. What a plan writes is recorded as verified (made
// by the assistant, confirmed by the approver) unless the user asks for it to
// count as human-made; a contributor's approval records it as their own
// unreviewed work (`contributedBy`, provenance convention). The service
// refuses a second application of the same plan (a retried request, a double
// click), so a failure leaves the plan undecided and approving again is safe.
export const startApply = ({
  store,
  service,
  conv,
  prevMeta,
  plan,
  asHuman,
  contributedBy = null,
  docked = false,
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
    prevMeta,
    progress: 'Applying changes…',
  });
  jobs.set(conv.id, j);
  // The attempt is recorded before it is made, so a tab that comes back
  // knows a plan was approved and rejoins, or offers to apply again.
  const meta = buildMeta(prevMeta, conv, service, {
    kind: 'apply',
    requestId,
    serviceId: service.serviceId,
    planId: plan.id,
    asHuman,
    contributedBy,
    startedAt: new Date().toISOString(),
  });
  j.promise = (async () => {
    await persistConv(store, conv, meta, { metaOnly: true });
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        {
          projectId,
          conversationId: conv.id,
          approve: { planId: plan.id, asHuman, contributedBy },
        },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        undefined,
        { requestId },
      ),
    );
    applyToasts(j, plan.summary, { docked });
    return finishJob(j, store, service);
  })();
  return j;
};

// Rejoin the request a conversation's record says is under way (it was
// submitted from a page that is gone). The record gets the outcome either
// way; this is for showing progress and refreshing when it lands.
export const attachJob = ({ store, conv, meta, docked = false }) => {
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
    prevMeta: meta,
    progress: p.kind === 'apply' ? 'Applying changes…' : 'Thinking…',
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
    if (j.kind === 'apply') {
      const plan = conv.display.find((d) => d.plan?.id === j.planId)?.plan;
      applyToasts(j, plan?.summary || 'the changes', { docked });
    }
    return finishJob(j, store, null);
  })();
  return j;
};

// Ask the service to stop a turn. It stops between steps and settles the
// record; if the request is already gone, end our side and settle here.
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
// sit in the sidebar like any other, and turns into a saved one the moment the
// first message goes out.
export const newConversation = () => ({ id: newId(), messages: [], display: [], draft: true });

// The model that wrote the reply before this one. A conversation keeps the
// assistant it started with, but that one can go offline and another answer
// in its place, and then the transcript should say where each reply came from.
export const previousModel = (display, i) => {
  for (let k = i - 1; k >= 0; k--) {
    if (display[k].kind === 'assistant') return display[k].model || null;
  }
  return null;
};

// Whether the question at `i` was asked from somewhere new. Marking every
// message with where it was asked from says the same thing over and over in a
// thread that never moved; marking the CHANGES says the one thing a reader of
// an old thread cannot otherwise recover. The service's stamp on the model's
// own copy follows the same rule, for the same reason.
export const movedHere = (display, i) => {
  const here = display[i]?.where;
  if (!here) return false;
  for (let k = i - 1; k >= 0; k--) {
    const was = display[k].kind === 'user' ? display[k].where : null;
    if (was) return was.kind !== here.kind || was.id !== here.id;
  }
  return true;
};
