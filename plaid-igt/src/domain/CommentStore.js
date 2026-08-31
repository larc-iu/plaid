// Single source of truth for one document's comments.
//
// Framework-agnostic — no React imports here, mirroring IgtDocument. The React
// bridge lives in useCommentStore.js, and the lit-html island reads this
// directly. That is what lets the Comments tab and the Analyze grid share a
// model instead of passing messages.
//
// Comments are SOCIAL data, not annotation data, which is why this is a
// separate store rather than part of IgtDocument: they are unaudited, they must
// never bump the document version, and they are deliberately absent from the
// document read. Nothing in here goes through `client.withOperation`.

// Comments sort oldest-first by (createdAt, id), matching the server's keyset
// order so a locally-inserted comment and a re-fetched page agree.
const byCreated = (a, b) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;

// An id for an optimistic comment that has not been acknowledged yet. Prefixed
// so it can never collide with a server UUID, and so `pendingId?.startsWith`
// is enough to recognize one.
let tempSeq = 0;
const tempId = () => `pending:${++tempSeq}`;
export const isPending = (comment) =>
  typeof comment?.id === 'string' && comment.id.startsWith('pending:');

/**
 * Normalize an SSE comment notification into the camelCase shape the rest of
 * the client uses.
 *
 * SSE `message` payloads are opaque application data and are NOT key-
 * transformed by plaid-client, so a comment event arrives kebab-cased
 * (`entity-id`) while the same fields off `client.comments.list` arrive
 * camelCased (`entityId`). Converting once, here, keeps that asymmetry from
 * leaking into every call site.
 *
 * Returns null for anything that is not a comment event.
 */
export function normalizeCommentEvent(data) {
  if (!data || data.type !== 'comment') return null;
  return {
    action: data.action, // created | updated | deleted
    commentId: data['comment-id'],
    documentId: data['document-id'],
    entityType: data['entity-type'],
    entityId: data['entity-id'],
    authorId: data['author-id'],
  };
}

export class CommentStore {
  constructor({ client, projectId, documentId, currentUserId = null }) {
    this._client = client;
    this._projectId = projectId;
    this._documentId = documentId;
    this._currentUserId = currentUserId;

    this._byEntity = new Map(); // entityId -> Comment[] (oldest first)
    this._byId = new Map(); // commentId -> Comment
    // authorId -> display name. A comment carries only its author's id (which
    // IS their email), and a thread showing raw emails reads like a mail
    // client. Resolved lazily and cached for the life of the store, since a
    // display name changing mid-session is not worth a re-fetch.
    this._authors = new Map();
    this._loaded = false;
    this._error = '';
    this._version = 0;
    this._listeners = new Set();

    // Optional sink for surfacing errors loudly (a toast). Framework-agnostic:
    // the mount wrapper sets this to notifyError; tests leave it null. Same
    // contract as IgtDocument.onError.
    this.onError = null;
  }

  // ============================================================
  // Subscription (mirrors IgtDocument so useSyncExternalStore is happy —
  // arrow fields keep the identities stable across renders).
  // ============================================================

  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = () => this._version;

  _emit() {
    this._version++;
    this._listeners.forEach((fn) => fn());
  }

  // ============================================================
  // Reads
  // ============================================================

  get isLoaded() {
    return this._loaded;
  }

  get error() {
    return this._error;
  }

  get documentId() {
    return this._documentId;
  }

  get currentUserId() {
    return this._currentUserId;
  }

  /** How many comments the document has in total. O(1) — the tab badge reads
   * this on every render, where `all.length` would sort the whole document. */
  get count() {
    return this._byId.size;
  }

  /** Every comment in the document, oldest first. */
  get all() {
    return [...this._byId.values()].sort(byCreated);
  }

  /** How many comments hang off one entity. Drives the grid badge. */
  countFor(entityId) {
    return this._byEntity.get(entityId)?.length ?? 0;
  }

  /** One entity's thread, oldest first. Never null. */
  threadFor(entityId) {
    return this._byEntity.get(entityId) ?? [];
  }

  /**
   * Every thread in the document as `[{ entityType, entityId, comments }]`,
   * ordered by each thread's oldest comment. What the Comments tab renders.
   */
  threads() {
    const out = [];
    for (const [entityId, comments] of this._byEntity) {
      if (!comments.length) continue;
      out.push({ entityId, entityType: comments[0].entityType, comments });
    }
    return out.sort((a, b) => byCreated(a.comments[0], b.comments[0]));
  }

  /** True when the user may edit this comment: authorship, and nothing else. */
  canEdit(comment) {
    return (
      !!this._currentUserId && comment?.authorId === this._currentUserId && !isPending(comment)
    );
  }

  /**
   * An author's display name, falling back to their id (an email) until the
   * lookup lands or if it fails. Synchronous so the island can call it during
   * render; `_resolveAuthors` is what fills the cache.
   */
  authorName(userId) {
    return this._authors.get(userId) ?? userId ?? 'Unknown';
  }

  /**
   * Look up display names for any author we have not seen yet, in parallel,
   * and emit once at the end. Failures fall back to the id rather than
   * retrying forever — the same `.catch(() => id)` shape AccessManagement uses.
   */
  async _resolveAuthors() {
    const missing = [...new Set([...this._byId.values()].map((c) => c.authorId))].filter(
      (id) => id && !this._authors.has(id),
    );
    if (!missing.length) return;
    // Claim the ids up front so a second load in flight does not re-request them.
    missing.forEach((id) => this._authors.set(id, id));
    const resolved = await Promise.all(
      missing.map((id) =>
        this._client.users
          .get(id)
          .then((u) => [id, u?.displayName || id])
          .catch(() => [id, id]),
      ),
    );
    let changed = false;
    for (const [id, name] of resolved) {
      if (this._authors.get(id) !== name) {
        this._authors.set(id, name);
        changed = true;
      }
    }
    if (changed) this._emit();
  }

  // ============================================================
  // Loading
  // ============================================================

  /**
   * Fetch every comment in the document. ONE request paints every badge —
   * `client.comments.list` auto-paginates, and the server indexes this read on
   * (document_id, created_at, id).
   */
  async load() {
    try {
      const all = await this._client.comments.list(this._projectId, {
        documentId: this._documentId,
      });
      this._index(all);
      this._loaded = true;
      this._error = '';
      // Deliberately not awaited: badges and bodies render without names, and
      // blocking the whole load on a per-author fetch would delay them for a
      // cosmetic detail. `_resolveAuthors` emits again when the names land.
      this._authorsPromise = this._resolveAuthors();
    } catch (err) {
      this._fail('Failed to load comments', err);
    }
    this._emit();
  }

  /** Test/refresh hook: resolves once the in-flight author lookups settle. */
  whenAuthorsResolved() {
    return this._authorsPromise ?? Promise.resolve();
  }

  _index(comments) {
    this._byEntity = new Map();
    this._byId = new Map();
    for (const c of [...comments].sort(byCreated)) this._insert(c);
  }

  _insert(comment) {
    this._byId.set(comment.id, comment);
    const list = this._byEntity.get(comment.entityId);
    if (list) list.push(comment);
    else this._byEntity.set(comment.entityId, [comment]);
  }

  _forget(commentId) {
    const existing = this._byId.get(commentId);
    if (!existing) return null;
    this._byId.delete(commentId);
    const list = this._byEntity.get(existing.entityId);
    if (list) {
      const next = list.filter((c) => c.id !== commentId);
      if (next.length) this._byEntity.set(existing.entityId, next);
      else this._byEntity.delete(existing.entityId);
    }
    return existing;
  }

  _fail(label, err) {
    console.error(`${label}:`, err);
    this._error = `${label}: ${err?.message || 'Unknown error'}`;
    // The raw error rides along so the UI can humanize it (statuses, network
    // failures) while keeping the label. Same contract as IgtDocument.
    if (this.onError) this.onError(this._error, err, label);
  }

  clearError() {
    if (!this._error) return;
    this._error = '';
    this._emit();
  }

  // ============================================================
  // Writes
  //
  // All three are optimistic. A comment is small, the failure mode is a
  // visible rollback plus a toast, and a spinner between typing and seeing
  // your own words is the thing that makes a comment box feel slow.
  // ============================================================

  /** Post a comment. Returns the created comment, or null if the write failed. */
  async post(entityType, entityId, body) {
    const text = String(body ?? '').trim();
    if (!text) return null;

    const optimistic = {
      id: tempId(),
      projectId: this._projectId,
      documentId: this._documentId,
      entityType,
      entityId,
      authorId: this._currentUserId,
      body: text,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      edited: false,
    };
    optimistic.updatedAt = optimistic.createdAt;
    this._insert(optimistic);
    this._emit();

    try {
      const created = await this._client.comments.create(entityType, entityId, text);
      // Swap the placeholder for the server's row rather than re-fetching: the
      // response is the authoritative comment, ids and timestamps included.
      this._forget(optimistic.id);
      this._insert(created);
      this._byEntity.get(created.entityId)?.sort(byCreated);
      this._emit();
      return created;
    } catch (err) {
      this._forget(optimistic.id);
      this._fail('Failed to post comment', err);
      this._emit();
      return null;
    }
  }

  /** Edit a comment's body. Only its author may; the server enforces that. */
  async edit(commentId, body) {
    const existing = this._byId.get(commentId);
    const text = String(body ?? '').trim();
    if (!existing || !text || text === existing.body) return false;

    const before = { ...existing };
    Object.assign(existing, { body: text, edited: true });
    this._emit();

    try {
      const updated = await this._client.comments.update(commentId, text);
      Object.assign(existing, updated);
      this._emit();
      return true;
    } catch (err) {
      Object.assign(existing, before);
      this._fail('Failed to edit comment', err);
      this._emit();
      return false;
    }
  }

  /** Delete a comment. The author may delete their own, a maintainer any. */
  async remove(commentId) {
    const removed = this._forget(commentId);
    if (!removed) return false;
    this._emit();

    try {
      await this._client.comments.delete(commentId);
      return true;
    } catch (err) {
      // Put it back where it was rather than dropping the user's words on a
      // transient failure.
      this._insert(removed);
      this._byEntity.get(removed.entityId)?.sort(byCreated);
      this._fail('Failed to delete comment', err);
      this._emit();
      return false;
    }
  }

  // ============================================================
  // Live updates
  // ============================================================

  /**
   * Apply an SSE comment notification. `data` is the raw (kebab-cased) message
   * payload; anything that is not a comment event for this document is ignored.
   *
   * The event carries no body by design, so this re-reads the one thread it
   * names. That keeps a single serialization shape of a comment and removes any
   * partial-merge logic — at the cost of one small request per remote change,
   * which is the right trade for a feature this chatty.
   */
  async applyEvent(data) {
    const evt = normalizeCommentEvent(data);
    if (!evt || evt.documentId !== this._documentId) return false;
    // Our own writes are already applied optimistically; re-reading on the echo
    // would only make our own comment flicker.
    if (evt.authorId && evt.authorId === this._currentUserId) return false;

    try {
      const thread = await this._client.comments.list(this._projectId, {
        entityType: evt.entityType,
        entityId: evt.entityId,
      });
      for (const c of this.threadFor(evt.entityId).slice()) this._forget(c.id);
      for (const c of [...thread].sort(byCreated)) this._insert(c);
      this._emit();
      // A remote comment can be the first one from this author in this session.
      this._authorsPromise = this._resolveAuthors();
      return true;
    } catch (err) {
      // A dropped live update is not worth a toast: the thread is still correct
      // as of the last load, and the next one repairs it.
      console.error('Failed to refresh comment thread:', err);
      return false;
    }
  }
}
