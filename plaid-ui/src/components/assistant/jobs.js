import { notifySuccess, notifyError, notifyWarning } from '../../lib/notify.js';
import { humanizeError, refusalSaid } from '../../lib/errors.js';
import { deleteConversationFiles } from './attachments.js';
import { lastProjects } from './projectReach.js';
import { compactPlan } from './planRecord.js';
import { itemTime } from './itemTime.js';
import { recordBytes } from './usage.js';
import { uuidv4 } from '../../../../plaid-client-js/src/ids.js';

// The assistant's conversations and the runs behind them: what is stored
// where, the page-independent job registry, and starting, watching,
// rejoining, and stopping a run. No React in here.
// A stream, not a deadline: the service keeps its own budget per turn.
const REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;

const TITLE_MAX = 60;

// Said when the page gives up waiting on a request the service is still
// running. The conversation record is where the answer lands, so it is there
// to be picked up.
const LOST_CONTACT =
  'Lost contact with the assistant. It is still working. Reload to pick it back up.';

// The record is at the server's size limit, so a message cannot be added.
const CONVERSATION_FULL =
  'This conversation is full, so the message was not sent. Start a new conversation to go on.';

// The record keys carry the app's tag, the same one the service writes
// (plaid_agent/core/conversation.py), so one user's ud: and igt: records
// never collide.
const metaKey = (app, projectId, id) => `${app}:assistant:${projectId}:meta:${id}`;

const convKey = (app, projectId, id) => `${app}:assistant:${projectId}:conv:${id}`;

const metaPrefix = (app, projectId) => `${app}:assistant:${projectId}:meta:`;

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

const titleFrom = (text) => {
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
const registry = (globalThis.__plaidAssistantJobs ??= {
  serviceCache: new Map(), // project id -> services, so a remount need not blank the picker
  saveQueues: new Map(), // conversation id -> Promise (writes in order)
  jobs: new Map(), // conversation id -> job in flight
  jobListeners: new Set(), // mounted components
  lastOpen: new Map(), // project id -> the conversation shown when the tab was last left
});
export const { serviceCache, saveQueues, jobs, jobListeners, lastOpen } = registry;

export const jobFor = (id) => (id ? jobs.get(id) || null : null);

const notifyJob = (j) => jobListeners.forEach((fn) => fn(j));

// An entry after a write, back in its place in the list. SORTED rather than
// moved to the front: opening a conversation re-reads its record without
// changing it, and hoisting it there moved every other row under the pointer
// that had just clicked one.
export const upsert = (meta) => (prev) =>
  [meta, ...prev.filter((m) => m.id !== meta.id)].sort(byRecency);

// The sidebar entry after a write. `pending` names the request under way, if
// any: {kind, requestId, serviceId, planId, asHuman, startedAt}.
//
// It carries the project it is written under, because the list holds rows from
// more than one (All projects) and each is deleted and linked to under its OWN
// project. An entry that named none put a row back into the list that had
// forgotten where it lived. A listed row is still attributed from its KEY,
// which is where a record's project is decided.
export const buildMeta = (store, prev, conv, service, pending = null, about = null) => {
  const firstUser = conv.display.find((d) => d.kind === 'user');
  return {
    id: conv.id,
    projectId: store.projectId,
    title: prev?.title || (firstUser ? titleFrom(firstUser.text) : 'New conversation'),
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceId: service?.serviceId || prev?.serviceId || null,
    model: service?.extras?.model || prev?.model || null,
    // Which version of it, as each turn names it (the service advertises it).
    version: service?.extras?.version || prev?.version || null,
    turns: conv.display.filter((d) => d.kind === 'user').length,
    // The document the conversation was started from, if any. It is what the
    // tab's list tags a row with, and it never changes once set: a
    // conversation belongs to where it began.
    about: prev?.about || about,
    pending,
  };
};

// How many times a write of the record is made again on what is stored when
// another writer's write landed first.
const WRITE_TRIES = 8;

const moved = (e) => e?.status === 409;

// The pending marker a write leaves on the sidebar entry `stored`, when it
// meant to leave `meta.pending`: its own, or, for a write that settles
// (leaves none), the stored one when that names a request other than
// `settles`, which is newer work (a turn another tab started).
const pendingOver = (stored, meta, settles) => {
  if (meta.pending) return meta.pending;
  const other = stored?.pending?.requestId;
  return other && other !== settles ? stored.pending : null;
};

// The sidebar entry `meta` written over the stored one: what is set once
// (title, when it began, where) as stored, the turn count from the record as
// it now stands, and the marker as `pendingOver` says.
const metaOver = (fresh, meta, settles) => ({
  ...meta,
  title: fresh.meta?.title || meta.title,
  createdAt: fresh.meta?.createdAt || meta.createdAt,
  about: fresh.meta?.about || meta.about || null,
  turns: fresh.conv.display.filter((d) => d.kind === 'user').length,
  pending: pendingOver(fresh.meta, meta, settles),
});

// Write a conversation (transcript + sidebar entry, or the entry alone).
// Writes for one conversation run one after another so a slow earlier PUT
// cannot land on top of a newer one.
//
// The record has a second writer, the service, and other tabs write it too.
// Each write names the version of the record the page's copy was read or last
// written at (`conv.rev`), and is refused (409) when another write landed
// since, rather than putting back a copy from before it. Then the record is
// read again and `rebase(fresh)` makes the change again on it: it answers
// `{conv, meta}` to write, or null when the change no longer applies (it is
// then not written, and the write resolves `{declined: true, fresh}`). A
// sidebar entry refused after its transcript landed is written again over the
// stored one (`metaOver`), keeping a marker that names a request other than
// `settles`. The written copy carries the versions it was written at.
//
// Resolves to `{conv, meta}` as written, `{declined, fresh}`, or false when
// the write failed. A failure is reported here, and a caller about to act on
// the record (a turn reads the message from it) must not go on without it.
//
// `failure` replaces the message a refused write shows, for a write that is
// not the sending of a message: a string, or a function of the error that
// answers one.
export const persistConv = (
  store,
  conv,
  meta,
  { metaOnly = false, failure = null, rebase = null, settles = null } = {},
) => {
  const { client, userId, app, projectId } = store;
  if (!userId) return Promise.resolve(false);
  const prev = saveQueues.get(conv.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      let c = conv;
      let m = meta;
      for (let i = 0; ; i += 1) {
        try {
          if (!metaOnly) {
            // Every settled plan as it is kept (planRecord.js), as the
            // service writes them too.
            // An answer shown as not saved (`withUnsavedAnswer`) stays out of
            // it, with its line, as when it was refused.
            const value = {
              messages: c.messages,
              display: c.display.filter((d) => !d.unsaved).map(compactPlan),
            };
            const put = await client.userData.put(userId, convKey(app, projectId, c.id), value, {
              version: c.rev?.conv,
            });
            // Its size beside its version, for the meter (usage.js): measured
            // once per write, never while drawing.
            c.rev = { ...c.rev, conv: put?.version, bytes: recordBytes(value) };
          }
          break;
        } catch (e) {
          if (!moved(e) || !rebase || i >= WRITE_TRIES) throw e;
          const fresh = await readRecord(store, c.id);
          const again = fresh.meta ? rebase(fresh) : null;
          if (!again) return { declined: true, fresh };
          c = again.conv;
          m = again.meta;
        }
      }
      for (let i = 0; ; i += 1) {
        try {
          const put = await client.userData.put(userId, metaKey(app, projectId, c.id), m, {
            version: c.rev?.meta,
          });
          c.rev = { ...c.rev, meta: put?.version };
          return { conv: c, meta: m };
        } catch (e) {
          if (!moved(e) || i >= WRITE_TRIES) throw e;
          const fresh = await readRecord(store, c.id);
          if (!fresh.meta) return { declined: true, fresh };
          if (metaOnly && rebase) {
            // A write of the entry alone is the change itself (an approval
            // marking its request): made again on the stored one.
            const again = rebase(fresh);
            if (!again) return { declined: true, fresh };
            m = again.meta;
          } else {
            m = metaOver(fresh, m, settles);
          }
          // The record as it now stands, which holds this write's transcript
          // and whatever landed after it.
          c = fresh.conv;
        }
      }
    })
    .catch((e) => {
      console.error('[Assistant] could not save the conversation', e);
      notifyError(
        (typeof failure === 'function' ? failure(e) : failure) ||
          (e?.status === 413
            ? CONVERSATION_FULL
            : humanizeError(e, 'Failed to save the conversation.')),
      );
      return false;
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
  await (saveQueues.get(id) || Promise.resolve());
  return readRecord(store, id, { strict: true });
};

// The record as the server has it, now (a write in progress reads it so).
// The copy carries the versions it was read at (`rev`), which the next write
// of it names (`persistConv`). Unless `strict`, a key that is gone (deleted
// in another tab) reads as empty, its sidebar entry as null.
const readRecord = async (store, id, { strict = false } = {}) => {
  const { client, userId, app, projectId } = store;
  const gone = (e) => {
    if (strict || e?.status !== 404) throw e;
    return null;
  };
  const [c, m] = await Promise.all([
    client.userData.get(userId, convKey(app, projectId, id)).catch(gone),
    client.userData.get(userId, metaKey(app, projectId, id)).catch(gone),
  ]);
  const v = c?.value || {};
  return {
    conv: {
      id,
      messages: v.messages || [],
      display: v.display || [],
      // The record's size as read, for the meter (usage.js).
      rev: {
        conv: c ? c.version : 0,
        meta: m ? m.version : 0,
        bytes: c ? recordBytes(v) : 0,
      },
    },
    // Under this project's keys is the only place it was looked for, so that is
    // the project it belongs to. The entry goes back into the list as it is,
    // and a row there has to know its own project.
    meta: m?.value ? { ...m.value, projectId } : null,
  };
};

// Delete one conversation: both keys, or neither. A transcript left behind
// without its sidebar entry could never be reached again.
//
// The keys are built from the ROW's OWN project. With the list widened past
// this project, deleting a foreign row asked for a key under the project on
// screen, which is a key that has never existed: a 404 every time, and the row
// stayed. Every row carries its project, whether it was listed, read back, or
// just written here.
export const deleteConversation = async (store, meta) => {
  const { client, userId, app } = store;
  const { projectId } = meta;
  // The files first: they are only ever reachable THROUGH the conversation, so
  // deleting the two keys first and then failing would leave them with nothing
  // left that names them. A conversation with no files pays one narrow listing.
  await deleteConversationFiles(store, projectId, meta.id);
  return Promise.all([
    client.userData.delete(userId, convKey(app, projectId, meta.id)),
    client.userData.delete(userId, metaKey(app, projectId, meta.id)),
  ]);
};

// A settled plan's card without what only approving it needed, keeping what
// it proposed (planRecord.js). The service does the same to every settled
// plan (plaid_agent/core/conversation.py `compact_plan`).
export { compactPlan };

// A plan's outcome decided here (a discard): the status on its card and when
// it was settled, plus a note in the model transcript (user role) so the next
// turn knows.
export const settle = (conv, index, status, note) => ({
  ...conv,
  messages: note ? [...conv.messages, { role: 'user', content: note }] : conv.messages,
  display: conv.display.map((d, i) =>
    i === index ? compactPlan({ ...d, status, settledAt: new Date().toISOString() }) : d,
  ),
});

// The record when it holds more than the page's copy of it, else null: an
// answer the service wrote after the page stopped waiting for it (the server
// restarted under the request, and the page settled the turn as unanswered).
// Read before anything the page writes over the whole record (a message, a
// retry), so that write never puts back the copy from before the answer.
// `known` is the sidebar entry as the page last wrote or read it: while the
// stored entry is the same one, nothing else wrote the record, and the whole
// record (which can be megabytes) is not read. A record that cannot be read
// leaves the page's copy to stand.
export const recordAhead = async (store, conv, known = null) => {
  const { client, userId, app, projectId } = store;
  if (!conv || conv.draft || !userId) return null;
  try {
    await (saveQueues.get(conv.id) || Promise.resolve());
    const entry = (await client.userData.get(userId, metaKey(app, projectId, conv.id)))?.value;
    if (!entry || (known?.updatedAt && entry.updatedAt === known.updatedAt)) return null;
    const read = await readConv(store, conv.id);
    return read.meta && read.conv.display.length > conv.display.length ? read : null;
  } catch {
    return null;
  }
};

// A reply the service could not save, written into the record here. The
// request's result carries it whole (`item`, as the record would have held
// it), and the model's copy of the conversation gets its text. A reply with a
// plan replaces any plan still waiting, as the service's own write does
// (plaid_agent/core/conversation.py `replace_undecided`).
export const withAnswer = (conv, outcome) => {
  const { item } = outcome;
  const at = new Date().toISOString();
  const earlier = item.plan
    ? conv.display.map((d) =>
        d.plan && d.status == null && !d.interrupted
          ? compactPlan({ ...d, status: 'replaced', settledAt: at })
          : d,
      )
    : conv.display;
  return {
    ...conv,
    messages: [
      ...conv.messages,
      { role: 'assistant', content: outcome.message ?? item.text ?? '' },
    ],
    display: [...earlier, { ...item, createdAt: item.createdAt || itemTime() }],
  };
};

// An answer neither the service nor the page could write into the record,
// said with the page's reason. A record at the size limit takes nothing more,
// so the conversation is over.
const ANSWER_FULL =
  'This conversation is full, so the answer was not saved. Start a new conversation to go on.';

const answerNotSaved = (e) =>
  e?.status === 413
    ? ANSWER_FULL
    : `The answer was not saved. ${humanizeError(e, 'The server refused it.')}`;

// The record as stored with the answer the page could not save after it, as
// the panel shows it. Not stored, so it offers nothing to approve: its plan
// stays out (approving needs it in the record, where the service reads it),
// and so does what the answer would have done to the plans before it. A line
// after it says the answer is not saved. Both are flagged `unsaved`, which
// keeps them out of the next write of the record (`persistConv`).
const withUnsavedAnswer = (conv, item, e) => {
  const { plan, ...answer } = item;
  const said = plan
    ? 'This answer and its proposed changes were not saved, so the changes cannot be applied.'
    : 'This answer was not saved.';
  return {
    ...conv,
    display: [
      ...conv.display,
      { ...answer, unsaved: true, createdAt: item.createdAt || itemTime() },
      {
        kind: 'error',
        // Not a turn that failed: no Retry under it (AssistantChat).
        unsaved: true,
        text: e?.status === 413 ? `${said} This conversation is full.` : said,
        createdAt: itemTime(),
      },
    ],
  };
};

// How often, and for how long, a turn whose request went missing looks for
// an answer landing in its record. The server forgets a request when it
// restarts, while the service goes on with the turn and writes the answer
// when it is done, which can be minutes later.
const LATE_EVERY_MS = 5000;
const LATE_FOR_MS = 20 * 60 * 1000;

// Watch the record of a turn settled as unanswered, and show the answer if
// the service writes one after all. Only the small sidebar entry is read each
// time, and the whole record once that entry changes. Stops when this
// conversation runs something new, or the record changes some other way.
const followLate = async (store, j, settled) => {
  const { client, userId, app, projectId } = store;
  const since = settled.meta?.updatedAt;
  const end = Date.now() + LATE_FOR_MS;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, LATE_EVERY_MS));
    if (jobFor(j.id)) return;
    let entry;
    try {
      entry = (await client.userData.get(userId, metaKey(app, projectId, j.id)))?.value;
    } catch (e) {
      if (e?.status === 404) return; // deleted
      continue;
    }
    if (!entry || entry.updatedAt === since) continue;
    let read;
    try {
      read = await readConv(store, j.id);
    } catch {
      continue;
    }
    if (jobFor(j.id)) return;
    if (read.conv.display.length > settled.conv.display.length) {
      notifyJob({ ...j, error: null, outcome: null, late: true, result: read });
    }
    return;
  }
};

// A progress event carries the reply text written so far (`text`), whole
// each time; the step list keeps only what the assistant did between them.
const progressOf = (j) => (p) => {
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

// What the page writes when a job's stream ended and the record still names
// its request (the service never wrote the outcome): `{conv, meta, failure,
// gone}`, or null when the record no longer names it.
const settleJob = (j, conv, meta, store, service) => {
  if (meta?.pending?.requestId !== j.requestId) return null;
  let failure = null;
  let gone = false;
  if (j.kind === 'turn') {
    // A stop the service ended the request on without writing the record
    // (its result says `stopped`) is a stop like one this page saw.
    if (j.stopped || j.outcome?.stopped || j.outcome?.kind === 'stopped') {
      // The user's message stays in the model transcript whatever happened
      // to the turn, so the next message is read with what it follows.
      // Retry takes it off before sending it again (`rewindForRetry`).
      conv = {
        ...conv,
        display: [
          ...conv.display,
          { kind: 'error', stopped: true, text: 'Stopped.', createdAt: itemTime() },
        ],
      };
    } else if (j.outcome?.kind === 'turn' && j.outcome.item) {
      // The service has the answer and the record refused it: written here,
      // unless its transcript landed after all (the save lost its answer, and
      // only the marker is left to clear).
      const { item } = j.outcome;
      const landed = conv.display.some(
        (d) => d.kind === item.kind && d.createdAt === item.createdAt && d.text === item.text,
      );
      if (!landed) {
        conv = withAnswer(conv, j.outcome);
        failure = answerNotSaved;
      }
    } else if (j.error && j.error.status !== 404) {
      // As on a stop, the user's message stays in the model transcript.
      conv = {
        ...conv,
        display: [
          ...conv.display,
          {
            kind: 'error',
            // A send the server refused says why where it can be acted on
            // ("... Remove Kalamang from this conversation to go on.").
            text: refusalSaid(j.error) || humanizeError(j.error, 'The assistant failed to answer.'),
            createdAt: itemTime(),
          },
        ],
      };
    } else {
      // The request is simply gone: the message stays unanswered and the
      // tab offers to send it again. Gone from the server is not gone from
      // the service, which may still write the answer (`followLate`).
      gone = true;
    }
  } else {
    conv = {
      ...conv,
      display: conv.display.map((d) =>
        d.plan?.id === j.planId && d.status === null ? { ...d, interrupted: true } : d,
      ),
    };
  }
  return { conv, meta: buildMeta(store, meta, conv, service, null), failure, gone };
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
const finishJob = async (j, store, service) => {
  let conv;
  let meta;
  try {
    ({ conv, meta } = await readConv(store, j.id));
  } catch (e) {
    console.error('[Assistant] could not read the conversation back', e);
    conv = j.conv;
    meta = buildMeta(store, j.prevMeta, conv, service);
  }
  const stillOut = j.error?.pending === true;
  if (stillOut && j.kind === 'turn') notifyWarning(LOST_CONTACT, 'Assistant');
  let gone = false;
  const settled = stillOut ? null : settleJob(j, conv, meta, store, service);
  if (settled) {
    gone = settled.gone;
    let refused = null;
    // Made again on the record as stored when another write landed first
    // (the service's late answer, another tab): settled there only while it
    // still names this request.
    const written = await persistConv(store, settled.conv, settled.meta, {
      // Nothing is added to an unanswered turn: its marker alone is cleared.
      metaOnly: settled.gone,
      ...(settled.failure
        ? {
            failure: (e) => {
              refused = e;
              return settled.failure(e);
            },
          }
        : {}),
      settles: j.requestId,
      rebase: (fresh) => settleJob(j, fresh.conv, fresh.meta, store, service),
    });
    if (written?.declined) {
      ({ conv, meta } = written.fresh);
      gone = false;
    } else if (written) {
      ({ conv, meta } = written);
    } else if (settled.failure) {
      // The answer is in neither the record nor the service: shown once, as
      // not saved, on the record as it was read.
      meta = settled.meta;
      if (refused?.status === 413) {
        // A record too full for the answer refuses it however often it is
        // asked, so the request is settled on the entry too. Left marked, every
        // load rejoined it and was refused again.
        const cleared = await persistConv(
          store,
          conv,
          buildMeta(store, meta, conv, service, null),
          {
            metaOnly: true,
            settles: j.requestId,
            rebase: (fresh) =>
              fresh.meta?.pending?.requestId === j.requestId
                ? {
                    conv: fresh.conv,
                    meta: buildMeta(store, fresh.meta, fresh.conv, service, null),
                  }
                : null,
          },
        );
        if (cleared && !cleared.declined) ({ conv, meta } = cleared);
      }
      conv = withUnsavedAnswer(conv, j.outcome.item, refused);
    } else {
      ({ conv, meta } = settled);
    }
  }
  j.done = true;
  j.result = { conv, meta };
  notifyJob(j);
  jobs.delete(j.id);
  notifyJob(j);
  if (gone) followLate(store, j, j.result);
  return j.result;
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
  ...fields,
});

// Where the conversation BEGAN, as the sidebar entry stores it: the field name
// IS the kind, so `{documentId, documentName}` beside a document and
// `{lexiconId, lexiconName}` beside a vocabulary. Written once, on the first
// turn, from the live `where` that turn carried.
//
// Spelled from the kind rather than switched on, so the record layer names no
// app's own vocabulary and an app that grows a third kind of screen needs
// nothing here.
export const aboutOf = (where) =>
  where?.kind && where.id
    ? { [`${where.kind}Id`]: where.id, [`${where.kind}Name`]: where.name ?? null }
    : null;

// The message `asked` (the display item) and `said` (the model's copy) after
// the record as stored, for a send whose write was refused because another
// landed first: an answer the service wrote after this page stopped waiting
// for it stays, and the question goes after it. Null when the message no
// longer goes there: a turn is under way (another tab asked), or it is a
// retry, which is asked again only from a record the reader has seen.
const askedAgain = (store, fresh, asked, said, service, meta) => {
  if (!asked || asked.retry || fresh.meta?.pending) return null;
  const has = fresh.conv.display.some(
    (d) => d.kind === asked.kind && d.createdAt === asked.createdAt && d.text === asked.text,
  );
  const conv = has
    ? fresh.conv
    : {
        ...fresh.conv,
        messages: [...fresh.conv.messages, said],
        display: [...fresh.conv.display, asked],
      };
  return {
    conv,
    meta: buildMeta(store, fresh.meta, conv, service, meta.pending, meta.about),
  };
};

// Run one turn for `conv`, whose last message is the user's.
export const startTurn = ({ store, service, conv, prevMeta, where = null }) => {
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
    store,
    prevMeta,
    conv,
    service,
    {
      kind: 'turn',
      requestId,
      serviceId: service.serviceId,
      startedAt: new Date(j.startedAt).toISOString(),
    },
    aboutOf(where),
  );
  j.promise = (async () => {
    // The record first: the service reads the message from it, and a tab
    // that comes back finds the request there. Any file the message carries is
    // already stored: the chat writes those before it builds the message, so a
    // file that could not be stored stops the send instead of going with it as
    // a reference to nothing.
    // A message that did not reach the record is never sent: the service
    // reads the message FROM the record, so it would answer the one before.
    // The text goes back to the composer (`unsent`) rather than being lost.
    const asked = conv.display.at(-1);
    const saved = await persistConv(store, conv, meta, {
      rebase: (fresh) => askedAgain(store, fresh, asked, conv.messages.at(-1), service, meta),
    });
    if (!saved) {
      j.unsent = asked?.text ?? null;
      return finishJob(j, store, service);
    }
    if (saved.declined) {
      // The record moved on under the message (a turn another tab started, or
      // the answer a retry asks for landed): nothing is sent. The record is
      // shown as it is, a turn under way there is followed, and a typed
      // message goes back to the composer.
      if (!asked?.retry) j.unsent = asked?.text ?? null;
      j.declined = true;
      j.done = true;
      j.result = saved.fresh;
      notifyJob(j);
      jobs.delete(j.id);
      notifyJob(j);
      const { conv: now, meta: nowMeta } = saved.fresh;
      if (nowMeta?.pending?.requestId && !jobFor(j.id))
        attachJob({ store, conv: now, meta: nowMeta });
      return j.result;
    }
    if (saved.conv !== conv) {
      // Written after what landed since the page read the record (an answer
      // the page had stopped waiting for): shown so while the turn runs.
      j.conv = saved.conv;
      j.rebased = true;
      notifyJob(j);
    }
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
        // The other projects the message reads. The server scopes the token it
        // hands the assistant to this project and those of these the reader
        // can open, so a turn reaches nothing else.
        //
        // `noOperation`: a turn is its own action. The client holds one open
        // operation, and an edit still saving would otherwise take it in.
        {
          requestId,
          projectIds: lastProjects(conv.display).map((p) => p.id),
          noOperation: true,
        },
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
    notifyError(humanizeError(j.error, 'Failed to apply the changes.'), 'Not applied');
  } else if (j.outcome?.partial) {
    // The card says it too, but a plan that stopped partway is not something
    // to leave to a glance at the card.
    notifyWarning(j.outcome.message, 'Partly applied');
  } else if (j.outcome && !j.outcome.duplicate && !docked) {
    notifySuccess(j.outcome.message || `Applied ${summary}.`, 'Changes applied');
  }
};

// Whether a finished job may have changed what the host screen shows, so it
// reloads. A plan that landed did, and so may one that failed partway or lost
// its answer. One refused as out of date proves the screen was already old.
// Only an apply still running on the server has nothing new to show yet.
export const changesTheView = (j) => !!j.done && j.kind === 'apply' && !j.error?.pending;

// Apply `plan` from `conv`. What a plan writes is recorded as verified (made
// by the assistant, confirmed by the approver) unless the user asks for it to
// count as human-made. Whether the approver's work is reviewed, so recorded
// as their own unreviewed work, the service reads from the project itself
// (`plaid.review`, provenance convention), not from the page. The service
// refuses a second application of the same plan (a retried request, a double
// click), so a failure leaves the plan undecided and approving again is safe.
export const startApply = ({ store, service, conv, prevMeta, plan, asHuman, docked = false }) => {
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
  const meta = buildMeta(store, prevMeta, conv, service, {
    kind: 'apply',
    requestId,
    serviceId: service.serviceId,
    planId: plan.id,
    asHuman,
    startedAt: new Date(j.startedAt).toISOString(),
  });
  j.promise = (async () => {
    // Marked on the entry as stored, unless something else is under way there
    // or the plan was decided meanwhile (another tab): then nothing is asked.
    const saved = await persistConv(store, conv, meta, {
      metaOnly: true,
      rebase: (fresh) =>
        fresh.meta?.pending || !undecided(fresh.conv, plan.id)
          ? null
          : {
              conv: fresh.conv,
              meta: buildMeta(store, fresh.meta, fresh.conv, service, meta.pending),
            },
    });
    if (saved?.declined) {
      j.declined = true;
      j.done = true;
      j.result = saved.fresh;
      notifyJob(j);
      jobs.delete(j.id);
      notifyJob(j);
      return j.result;
    }
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        {
          projectId,
          conversationId: conv.id,
          approve: { planId: plan.id, asHuman },
        },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        undefined,
        // Approving is its own action, applied as one assistant-plan
        // operation the service opens. The client holds one open operation,
        // so an edit still saving would otherwise take in every write of the
        // plan, under the edit's kind.
        { requestId, noOperation: true },
      ),
    );
    applyToasts(j, plan.summary, { docked });
    const result = await finishJob(j, store, service);
    if (j.error && !j.error.pending && undecided(result.conv, plan.id)) {
      followSettle(store, j, plan.id);
    }
    return result;
  })();
  return j;
};

const undecided = (conv, planId) =>
  (conv?.display ?? []).some((d) => d.plan?.id === planId && d.status == null);

// How often, and how many times, a refused approval rereads its record.
const SETTLE_EVERY_MS = 3000;
const SETTLE_TRIES = 30;

// An approval refused while the plan is still undecided may have lost to an
// approval of the same plan from another tab, whose run held the document
// (H8-ASSISTANT-3). That run settles the record when it ends, so the record
// is read again until the plan is decided there, and the card shows it then,
// rather than offering Approve over a plan already applied. Stops at once when
// this conversation runs something new.
const followSettle = async (store, j, planId) => {
  for (let i = 0; i < SETTLE_TRIES; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_EVERY_MS));
    if (jobFor(j.id)) return;
    let read;
    try {
      read = await readConv(store, j.id);
    } catch {
      continue;
    }
    if (jobFor(j.id)) return;
    if (!undecided(read.conv, planId)) {
      // Shown as the finished apply it now is, so the host refreshes too.
      notifyJob({ ...j, error: null, outcome: null, result: read });
      return;
    }
  }
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
//
// Its first write names version 0, which only creates: an id is never taken
// twice, so a record already there is another tab's.
export const newConversation = () => ({
  id: newId(),
  messages: [],
  display: [],
  draft: true,
  rev: { conv: 0, meta: 0 },
});
