import { transformRequest } from "./transforms.js";

// ---------------------------------------------------------------------------
// Client events: the opt-in research telemetry of a project (core manual,
// "Research telemetry").
//
// `client.events.record(type, fields)` is a fire-and-forget recorder. It
// buffers events and sends them every FLUSH_INTERVAL_MS or FLUSH_AT events,
// and when the page is hidden (`pagehide`, with `keepalive` so the request
// outlives the page). A batch that fails is dropped: no retry, no toast, no
// error for the caller. Nothing it does can block or break the screen that
// called it.
//
// It sends nothing for a project whose switch is off. The switch is read
// from the project (`config.plaid.research.telemetry`). An "on" is kept for
// FLAG_TTL_MS, one flush interval, and an "off" for FLAG_OFF_TTL_MS, so a
// switch another maintainer turns on reaches an open page within a minute,
// while a page whose switch is off, which records on every render of a grid,
// does not read the project every few seconds. An event recorded while an old
// "off" is being read again waits for the answer rather than being dropped.
// `events.setEnabled` tells it at once, which is what the settings checkbox
// does. A server refusal (the switch was turned off since) turns it off here
// too.
//
// ONE recorder per server per page, whatever client records into it: an app
// makes a client per editor, and a suggestion's "shown" is deduplicated for
// the page session, not per client. The last client to record lends its
// token to the next send.
// ---------------------------------------------------------------------------

/** Every event type the server accepts. */
export const EVENT_TYPES = Object.freeze([
  "suggestion.shown",
  "suggestion.adopted",
  "suggestion.dismissed",
  "plan.opened",
]);

export const FLUSH_INTERVAL_MS = 10000;
export const FLUSH_AT = 50;
export const FLAG_TTL_MS = FLUSH_INTERVAL_MS;
export const FLAG_OFF_TTL_MS = 60000;
// Events per request. A browser refuses a `keepalive` request whose body,
// with every other keepalive request still in flight, passes 64 KiB, and a
// refused request is lost. So the pagehide send goes out in small pieces, and
// only that send is keepalive: a backlog sent while the page stays (the first
// page of a grid, drawn while the switch was still being read, can hold
// hundreds of guesses) would otherwise lose everything past the quota. The
// server takes up to 500 in one request.
const PER_REQUEST = FLUSH_AT;
// A suggested or written value is a gloss, not prose. A long one is cut, in
// code points as the server counts them, so no character is split in two.
// The server refuses a value past this length, and a key its type does not
// take (core manual, "Research telemetry").
const MAX_VALUE_CHARS = 200;

const clip = (v) => {
  if (typeof v !== "string" || v.length <= MAX_VALUE_CHARS) return v;
  const cps = Array.from(v);
  return cps.length > MAX_VALUE_CHARS
    ? cps.slice(0, MAX_VALUE_CHARS).join("")
    : v;
};

export class EventRecorder {
  /**
   * @param {object} [opts]
   * @param {function} [opts.now] - Clock, for tests
   * @param {object} [opts.window] - Where `pagehide` fires (default globalThis)
   */
  constructor({ now = () => Date.now(), window = globalThis } = {}) {
    this.client = null;
    this.buffer = [];
    this.timer = null;
    this.now = now;
    // projectId -> { state: 'on' | 'off' | 'pending', at }
    this.flags = new Map();
    // "shown" keys already recorded this page session.
    this.seen = new Set();
    this._onPageHide = () => this.flush({ keepalive: true });
    this.window = window;
    window?.addEventListener?.("pagehide", this._onPageHide);
  }

  /** Tell the recorder a project's switch, e.g. right after changing it. */
  setEnabled(projectId, on) {
    this.flags.set(projectId, { state: on ? "on" : "off", at: this.now() });
    if (!on) this._drop(projectId);
    else if (this.buffer.length) this._schedule();
  }

  /**
   * Record one event. Returns true when it was buffered, false when it was
   * not (switch off, a repeat "shown", an unknown type, no project).
   */
  record(client, type, { projectId, documentId, targetId, data } = {}) {
    try {
      if (!EVENT_TYPES.includes(type) || !projectId) return false;
      this.client = client;
      const flag = this._flag(projectId);
      if (flag === "off") return false;
      // A key with no value is left out: the server takes only a string or
      // a number.
      const clipped = data
        ? Object.fromEntries(
            Object.entries(data)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, clip(v)]),
          )
        : undefined;
      let key = null;
      if (type === "suggestion.shown") {
        key = JSON.stringify([
          projectId,
          targetId ?? null,
          clipped?.field ?? null,
          clipped?.value ?? null,
        ]);
        if (this.seen.has(key)) return false;
        this.seen.add(key);
      }
      this.buffer.push({
        projectId,
        key,
        event: {
          type,
          documentId: documentId ?? undefined,
          targetId: targetId == null ? undefined : String(targetId),
          data: clipped,
          clientTs: new Date(this.now()).toISOString(),
        },
      });
      if (this.buffer.length >= FLUSH_AT) this.flush();
      else this._schedule();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send what is buffered for every project whose switch is known to be on,
   * drop what is buffered for one known to be off, and keep the rest until
   * the switch is known. With `keepalive` (the page is going away) nothing is
   * kept.
   */
  flush({ keepalive = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    const keep = [];
    const byProject = new Map();
    for (const entry of this.buffer) {
      const state = this.flags.get(entry.projectId)?.state;
      if (state === "on") {
        if (!byProject.has(entry.projectId)) byProject.set(entry.projectId, []);
        byProject.get(entry.projectId).push(entry.event);
      } else if (state === "off") {
        if (entry.key) this.seen.delete(entry.key);
      } else if (!keepalive) {
        keep.push(entry);
      }
    }
    this.buffer = keep;
    for (const [projectId, events] of byProject) {
      for (let i = 0; i < events.length; i += PER_REQUEST) {
        this._send(projectId, events.slice(i, i + PER_REQUEST), keepalive);
      }
    }
  }

  /** Stop listening for `pagehide` and forget everything (tests). */
  close() {
    clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
    this.window?.removeEventListener?.("pagehide", this._onPageHide);
  }

  _schedule() {
    if (this.timer == null) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  _drop(projectId) {
    this.buffer = this.buffer.filter((e) => {
      if (e.projectId !== projectId) return true;
      if (e.key) this.seen.delete(e.key);
      return false;
    });
  }

  // The switch as known now: 'on', 'off' or 'pending'. An unknown one sets
  // off a read of the project, and a stale one a fresh read. While it is
  // read, an old "on" stands and an old "off" is 'pending', so what is
  // recorded meanwhile waits for the answer. The answer flushes or drops what
  // is buffered.
  _flag(projectId) {
    const known = this.flags.get(projectId);
    const ttl = known?.state === "on" ? FLAG_TTL_MS : FLAG_OFF_TTL_MS;
    const fresh = known && this.now() - known.at < ttl;
    if (known && (fresh || known.checking)) return known.state;
    const state = known?.state === "on" ? "on" : "pending";
    this.flags.set(projectId, {
      state,
      at: known ? known.at : 0,
      checking: true,
    });
    const client = this.client;
    Promise.resolve()
      .then(() => client.projects.get(projectId))
      .then(
        (project) => project?.config?.plaid?.research?.telemetry === true,
        () => false,
      )
      .then((on) => {
        this.flags.set(projectId, { state: on ? "on" : "off", at: this.now() });
        if (!on) this._drop(projectId);
        else if (this.buffer.length >= FLUSH_AT) this.flush();
        else if (this.buffer.length) this._schedule();
      });
    return state;
  }

  _send(projectId, events, keepalive) {
    const client = this.client;
    try {
      const url = `${client.baseUrl}/api/v1/projects/${projectId}/events`;
      fetch(url, {
        method: "POST",
        keepalive,
        headers: {
          Authorization: `Bearer ${client.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(transformRequest(events)),
      }).then(
        (res) => {
          // The switch was turned off since it was read.
          if (res.status === 403) this.setEnabled(projectId, false);
        },
        () => {},
      );
    } catch {
      /* dropped, as every failed batch is */
    }
  }
}

const recorders = new Map();

/** The page's recorder for `client`'s server. */
export function recorderFor(client) {
  let r = recorders.get(client.baseUrl);
  if (!r) {
    r = new EventRecorder();
    recorders.set(client.baseUrl, r);
  }
  return r;
}

/** Forget every recorder (tests). */
export function resetEventRecorders() {
  for (const r of recorders.values()) r.close();
  recorders.clear();
}
