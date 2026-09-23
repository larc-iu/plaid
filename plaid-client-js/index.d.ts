/** A single page of a cursor-paginated collection. */
interface Page<T = any> {
  entries: T[];
  nextCursor: string | null;
}

/** One choice for an `enum` / `multiselect` service parameter. */
interface ServiceParamOption {
  value: string;
  label: string;
}

/** A single user-controllable argument a service advertises. */
interface ServiceParam {
  /** Key the value is sent under in the request payload. */
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum" | "multiselect" | "field";
  description?: string;
  default?: any;
  required?: boolean;
  /** Required for `enum` / `multiselect`. */
  options?: ServiceParamOption[];
  /** `number` only. */
  min?: number;
  max?: number;
  step?: number;
  /** `number` only: render as a slider to drag rather than a box to type in. */
  slider?: boolean;
  /** `string` only. */
  placeholder?: string;
  multiline?: boolean;
  /**
   * `field` only: the scope of the project's annotation fields the value names
   * one of. A `field` value is a string everywhere else.
   */
  scope?: "Sentence" | "Word" | "Morpheme";
}

/** A service's standardized self-description (lives in `extras`). */
interface ServiceExtras {
  schemaVersion?: number;
  /** Tasks this service serves; from the TASKS vocabulary. */
  tasks?: string[];
  /** Rich human description (markdown), beyond the short `description`. */
  summary?: string;
  /** Ordered parameter schema, rendered into a form by the UI. */
  parameters?: ServiceParam[];
  [key: string]: any;
}

interface ServiceInfo {
  serviceId: string;
  serviceName: string;
  description: string;
  extras?: ServiceExtras;
}

interface DiscoveredService {
  serviceId: string;
  serviceName: string;
  description: string;
  extras: ServiceExtras;
  /** true while the service holds an open request channel; false for previously-seen offline services. */
  online: boolean;
  /** ISO-8601 stamp of when the service was last seen alive, or null/undefined if never persisted. */
  lastSeenAt?: string | null;
}

interface ServiceRegistration {
  stop(): void;
  /** Still serving, including while retrying a channel through a server restart. */
  isRunning(): boolean;
  /** Channel open right now, i.e. the server currently sees this service as online. */
  isConnected(): boolean;
  serviceInfo: ServiceInfo & { extras: any };
}

/** Connection-state transitions reported by a service registration. */
type ServiceStatusEvent = "registered" | "reconnected" | "disconnected";

interface ResponseHelper {
  requestId: string;
  requesterId: string | null;
  /** True once the requester has asked this request to stop. */
  readonly cancelled: boolean;
  /**
   * Report progress — and a cancellation CHECKPOINT: throws
   * `ServiceCancelled` once a stop has been asked for, which is what makes a
   * service that already reports progress cancellable for free.
   */
  progress(percent: number, message: string, extra?: Record<string, any>): void;
  /** Stop here if the requester has asked the request to stop. */
  raiseIfCancelled(): void;
  /** Run `fn` as a stretch that must finish once begun, usually the writes. */
  critical<T>(fn: () => T | Promise<T>): Promise<T>;
  complete(data: any): void;
  /** End the request because it was asked to stop; result carries `stopped: true`. */
  stopped(data?: any): void;
  error(error: string | Error): void;
}

/** Thrown inside a handler when the requester has asked it to stop. */
export class ServiceCancelled extends Error {
  constructor(message?: string);
}

/** The cancellation half of a responseHelper, on its own. */
export function createCancelScope(isCancelled: () => boolean): {
  readonly cancelled: boolean;
  raiseIfCancelled(): void;
  critical<T>(fn: () => T | Promise<T>): Promise<T>;
};

interface SSEConnection {
  close(): void;
  getStats(): any;
  readyState: number;
}

interface VocabLinksBundle {
  create(
    vocabItem: string,
    tokens: any[],
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  setMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(id: string, auditMessage?: string): Promise<any>;
  patchMetadata(id: string, body: MetadataOp[], auditMessage?: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
}

interface VocabLayersBundle {
  get(id: string, includeItems?: boolean, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, name: string, auditMessage?: string): Promise<any>;
  setConfig(
    id: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    id: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: {
    limit?: number;
    cursor?: string;
    asOf?: string;
  }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string, auditMessage?: string): Promise<any>;
  addMaintainer(
    id: string,
    userId: string,
    auditMessage?: string,
  ): Promise<any>;
  removeMaintainer(
    id: string,
    userId: string,
    auditMessage?: string,
  ): Promise<any>;
}

interface RelationsBundle {
  setMetadata(
    relationId: string,
    body: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteMetadata(relationId: string, auditMessage?: string): Promise<any>;
  patchMetadata(
    relationId: string,
    body: MetadataOp[],
    auditMessage?: string,
  ): Promise<any>;
  setTarget(
    relationId: string,
    spanId: string,
    auditMessage?: string,
  ): Promise<any>;
  get(relationId: string, asOf?: string): Promise<any>;
  delete(relationId: string, auditMessage?: string): Promise<any>;
  update(relationId: string, value: any, auditMessage?: string): Promise<any>;
  setSource(
    relationId: string,
    spanId: string,
    auditMessage?: string,
  ): Promise<any>;
  create(
    layerId: string,
    sourceId: string,
    targetId: string,
    value: any,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  bulkUpdate(body: any[], auditMessage?: string): Promise<{ count: number }>;
}

interface SpanLayersBundle {
  setConfig(
    spanLayerId: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    spanLayerId: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  get(spanLayerId: string, asOf?: string): Promise<any>;
  delete(spanLayerId: string, auditMessage?: string): Promise<any>;
  update(
    spanLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
  create(
    tokenLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
  shift(
    spanLayerId: string,
    direction: string,
    auditMessage?: string,
  ): Promise<any>;
}

interface SpansBundle {
  setTokens(spanId: string, tokens: any[], auditMessage?: string): Promise<any>;
  create(
    spanLayerId: string,
    tokens: any[],
    value: any,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  get(spanId: string, asOf?: string): Promise<any>;
  delete(spanId: string, auditMessage?: string): Promise<any>;
  update(spanId: string, value: any, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  bulkUpdate(body: any[], auditMessage?: string): Promise<{ count: number }>;
  setMetadata(spanId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(spanId: string, auditMessage?: string): Promise<any>;
  patchMetadata(spanId: string, body: MetadataOp[], auditMessage?: string): Promise<any>;
}

interface TextsBundle {
  setMetadata(textId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(textId: string, auditMessage?: string): Promise<any>;
  patchMetadata(textId: string, body: MetadataOp[], auditMessage?: string): Promise<any>;
  create(
    textLayerId: string,
    documentId: string,
    body: string,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  get(textId: string, asOf?: string): Promise<any>;
  delete(textId: string, auditMessage?: string): Promise<any>;
  update(textId: string, body: any, auditMessage?: string): Promise<any>;
}

interface UsersBundle {
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: {
    limit?: number;
    cursor?: string;
    asOf?: string;
  }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(
    email: string,
    password: string,
    isAdmin: boolean,
    displayName?: string,
    auditMessage?: string,
  ): Promise<any>;
  audit(
    userId: string,
    startTime?: string,
    endTime?: string,
    asOf?: string,
  ): Promise<any[]>;
  auditPage(userId: string, opts?: AuditPageOptions): Promise<Page>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  activate(id: string, auditMessage?: string): Promise<any>;
  update(
    id: string,
    password?: string,
    displayName?: string,
    isAdmin?: boolean,
    auditMessage?: string,
  ): Promise<any>;
  /** URL for a user's profile picture, usable as an <img> src. Null when avatarHash is explicitly null. */
  avatarUrl(id: string, avatarHash?: string | null): string | null;
  getAvatar(id: string): Promise<any>;
  setAvatar(id: string, file: File | Blob, auditMessage?: string): Promise<any>;
  deleteAvatar(id: string, auditMessage?: string): Promise<any>;
}

interface UserDataEntry {
  key: string;
  updatedAt: string;
  value?: any;
}

interface UserDataOptions {
  prefix?: string;
  pattern?: string;
  includeValues?: boolean;
}

/** Private per-user key/value storage (owner or admin only; not audited). */
interface UserDataBundle {
  list(
    userId: string,
    opts?: UserDataOptions & { pageSize?: number },
  ): Promise<UserDataEntry[]>;
  listPage(
    userId: string,
    opts?: UserDataOptions & { limit?: number; cursor?: string },
  ): Promise<Page<UserDataEntry>>;
  iterPages(
    userId: string,
    opts?: UserDataOptions & { pageSize?: number },
  ): AsyncGenerator<UserDataEntry[]>;
  get(userId: string, key: string): Promise<UserDataEntry & { value: any }>;
  put(
    userId: string,
    key: string,
    value: any,
  ): Promise<{ key: string; updatedAt: string }>;
  delete(userId: string, key: string): Promise<any>;
}

interface CommentFilters {
  documentId?: string;
  entityType?: CommentableType;
  entityId?: string;
}

/** Entities that can carry a comment. */
type CommentableType =
  "document" | "text" | "token" | "span" | "relation" | "vocab-item";

/**
 * One entry in a project's annotation manual: a short Markdown document
 * stating a convention the project follows. Read by the people on the
 * project, and by the assistant before it proposes anything.
 */
interface Guideline {
  id: string;
  projectId: string;
  /** The handle the assistant asks for a guideline by. Not required to be unique. */
  title: string;
  /** The Markdown text. Present on a single read and on a list made with `includeBodies`. */
  body?: string;
  /** The body's length in characters. Present on a list made WITHOUT `includeBodies`. */
  bodyChars?: number;
  /** Whether the assistant is given this one in full on every turn. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GuidelinesBundle {
  create(
    projectId: string,
    title: string,
    opts?: { body?: string; pinned?: boolean },
    auditMessage?: string,
  ): Promise<{ id: string }>;
  get(id: string): Promise<Guideline>;
  update(
    id: string,
    changes?: {
      title?: string;
      body?: string;
      pinned?: boolean;
      /** Write only if this is still the stored updatedAt; 409 otherwise. */
      expectedUpdatedAt?: string;
    },
    auditMessage?: string,
  ): Promise<Guideline>;
  delete(id: string, auditMessage?: string): Promise<any>;
  list(
    projectId: string,
    opts?: { includeBodies?: boolean },
  ): Promise<Guideline[]>;
  listPage(
    projectId: string,
    opts?: { includeBodies?: boolean; limit?: number; cursor?: string },
  ): Promise<Page<Guideline>>;
  iterPages(
    projectId: string,
    opts?: { includeBodies?: boolean; pageSize?: number },
  ): AsyncGenerator<Guideline[]>;
}

interface Comment {
  id: string;
  /** The owning project, or null for a comment on a vocabulary entry. */
  projectId: string | null;
  /** The owning document, or null for a comment on a vocabulary entry. */
  documentId: string | null;
  /** The owning vocab layer, set only for a comment on a vocabulary entry. */
  vocabLayerId: string | null;
  entityType: CommentableType;
  entityId: string;
  /**
   * What the comment is about, in words, captured when it was posted. A
   * comment outlives its anchor, and this is what is left to show once the
   * anchor has been deleted.
   */
  anchorLabel: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** True once the body has been rewritten since it was posted. */
  edited: boolean;
}

interface CommentsBundle {
  create(
    entityType: CommentableType,
    entityId: string,
    body: string,
    opts?: { anchorLabel?: string },
  ): Promise<Comment>;
  get(id: string): Promise<Comment>;
  update(id: string, body: string): Promise<Comment>;
  delete(id: string): Promise<any>;
  list(projectId: string, filters?: CommentFilters): Promise<Comment[]>;
  listPage(
    projectId: string,
    opts?: CommentFilters & { limit?: number; cursor?: string },
  ): Promise<Page<Comment>>;
  iterPages(
    projectId: string,
    opts?: CommentFilters & { pageSize?: number },
  ): AsyncGenerator<Comment[]>;
  /** `{entityId: count}`; keys are raw entity ids, never key-transformed. */
  counts(
    projectId: string,
    filters?: CommentFilters,
  ): Promise<Record<string, number>>;
  /** Comments on a vocabulary's entries, oldest first. */
  listInVocab(
    vocabId: string,
    filters?: { entityId?: string },
  ): Promise<Comment[]>;
  listInVocabPage(
    vocabId: string,
    opts?: { entityId?: string; limit?: number; cursor?: string },
  ): Promise<Page<Comment>>;
  /** `{entryId: count}` over a vocabulary; keys are raw entry ids. */
  countsInVocab(
    vocabId: string,
    filters?: { entityId?: string },
  ): Promise<Record<string, number>>;
}

interface ApiTokensBundle {
  list(userId: string): Promise<any[]>;
  listPage(
    userId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<Page>;
  iterPages(
    userId: string,
    opts?: { pageSize?: number },
  ): AsyncGenerator<any[]>;
  create(
    userId: string,
    name: string,
    auditMessage?: string,
  ): Promise<{ id: string; name: string; token: string }>;
  revoke(userId: string, tokenId: string, auditMessage?: string): Promise<any>;
}

interface Invite {
  id: string;
  /** "signup" | "password-reset" */
  kind: string;
  /** "active" | "used" | "expired" | "revoked" */
  status: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  note: string | null;
  targetUserId: string | null;
  grantAdmin: boolean;
  projectId: string | null;
  projectRole: string | null;
}

interface InvitePreview {
  /** "signup" | "password-reset" */
  kind: string;
  /** "active" | "used" | "expired" | "revoked" */
  status: string;
  expiresAt: string;
  grantAdmin: boolean;
  projectName?: string;
  projectRole?: string;
  /** Present only for a password reset: the email of the account it belongs to. */
  email?: string;
}

interface CreateInviteOptions {
  projectId?: string;
  /** "reader" | "writer" | "maintainer" */
  projectRole?: string;
  grantAdmin?: boolean;
  /** Makes this a password reset for that user (admin only). */
  targetUserId?: string;
  maxUses?: number;
  ttlDays?: number;
  note?: string;
}

/** Server limits, as reported by /api/v1/info. An unset limit is absent. */
interface ServerLimits {
  mediaFileBytes?: number;
  jsonBodyBytes?: number;
  batchOperations?: number;
  metadataDepth?: number;
  metadataKeyCount?: number;
  metadataStringLength?: number;
  metadataTotalBytes?: number;
  userDataValueBytes?: number;
  guidelineTitleLength?: number;
  guidelineBodyLength?: number;
  /** How long a document lock is held before it lapses. */
  lockExpirationMs?: number;
}

interface ServerHealth {
  ok: boolean;
  version: string;
  uptimeMs: number;
  audit: { dbSizeMb?: number; auditRows?: number; error?: string };
}

interface DocumentLock {
  documentId: string;
  userId: string;
  expiresAt: number;
}

interface RateLimitBucket {
  ip: string;
  userId?: string;
  failures: number;
  limit: number;
  blocked: boolean;
}

interface RateLimitSnapshot {
  windowMs: number;
  logins: RateLimitBucket[];
  ips: RateLimitBucket[];
  invites: RateLimitBucket[];
}

interface BackupStatus {
  enabled: boolean;
  directory: string;
  retention: number;
  time: string;
  backups: Array<{ name: string; bytes: number; modified: string }>;
  ok?: boolean;
}

interface ServerReport {
  version: string;
  jvm: {
    uptimeMs: number;
    startedAt: string;
    java: string;
    heapUsed: number;
    heapMax: number;
  };
  database: {
    path: string | null;
    bytes: number | null;
    walBytes: number | null;
    slowQueryThresholdMs?: number;
    journalMode?: string;
    maxPoolSize?: number;
    tables: Record<string, number | null>;
  };
  media: {
    directory: string;
    files: number;
    bytes: number;
    orphans: number;
    orphanBytes: number;
  };
  backup: BackupStatus;
  settings: Record<string, any>;
}

/** Server-level facts. `info` is fetched at most once per client. */
interface ServerBundle {
  info(): Promise<{ limits: ServerLimits }>;
  limits(): Promise<ServerLimits>;
  health(): Promise<ServerHealth>;
}

/** Instance-wide operations. Every method requires a global admin. */
interface AdminBundle {
  server(): Promise<ServerReport>;
  backup(): Promise<BackupStatus>;
  locks(): Promise<{ entries: DocumentLock[] }>;
  releaseLock(documentId: string): Promise<{ result: string }>;
  rateLimits(): Promise<RateLimitSnapshot>;
  clearRateLimits(opts?: {
    ip?: string;
    userId?: string;
  }): Promise<{ result: string }>;
  logs(opts?: {
    limit?: number;
    q?: string;
    level?: string;
    status?: string;
    user?: string;
    method?: string;
  }): Promise<LiveLog>;
  logFile(opts?: {
    lines?: number;
  }): Promise<{ file: string | null; lines: string[]; error?: string }>;
  userData(opts?: AdminUserDataOptions): Promise<AdminUserDataEntry[]>;
  userDataPage(
    opts?: AdminUserDataOptions & { limit?: number; cursor?: string },
  ): Promise<Page<AdminUserDataEntry>>;
}

/** One HTTP request as the log buffer holds it. */
interface LoggedRequest {
  /** Epoch milliseconds. */
  ts: number;
  method: string;
  path: string;
  /** Query string with sensitive values replaced, or null. */
  query: string | null;
  /** Null when the handler threw before producing one. */
  status: number | null;
  ms: number;
  /** Null for a request nobody was authenticated for. */
  user: string | null;
  ip: string | null;
  /** Set when a named API token signed the request. */
  token: string | null;
  /** Exception class, when the handler threw. */
  error: string | null;
}

/** One log event that was not a request. */
interface LoggedEvent {
  ts: number;
  level: string;
  ns: string;
  message: string;
  trace?: string;
}

/**
 * The live log. Requests and events are buffered separately, so a burst of
 * requests cannot evict an error.
 */
interface LiveLog {
  requests: {
    entries: LoggedRequest[];
    /** How many passed the filters, which may exceed what `entries` holds. */
    matched: number;
    /** How many are buffered in total. */
    held: number;
    capacity: number;
    stats: {
      count: number;
      failures: number;
      serverErrors: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
      perMinute: number | null;
      oldest: number | null;
      newest: number | null;
    };
  };
  events: {
    entries: LoggedEvent[];
    matched: number;
    held: number;
    capacity: number;
    /** Counts per level of what the search matched, before the level filter. */
    byLevel: Record<string, number>;
  };
  /** Absolute path of the configured log file, or null when logging to stdout. */
  file: string | null;
}

/** Narrowings for the cross-account private-data listing. */
interface AdminUserDataOptions {
  /** Only keys starting with this literal head. */
  prefix?: string;
  /** Only keys matching this GLOB (`*` any run, `?` one character). */
  pattern?: string;
  includeValues?: boolean;
}

type AdminUserDataEntry = UserDataEntry & { userId: string };

/** Options for a single page of any audit log. */
interface AuditPageOptions {
  startTime?: string;
  endTime?: string;
  asOf?: string;
  opTypes?: string[] | string;
  /** "desc" pages newest-first; a cursor belongs to the direction that made it. */
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

/** One user's activity over a scope and window. */
interface ActivityTallyRow {
  user: { id: string; displayName?: string };
  operations: number;
  changes: number;
  documents: number;
  firstTs: string;
  lastTs: string;
  byDay?: Array<{ date: string; changes: number }>;
}

/** Instance-wide audit reads and the per-user aggregate. */
interface AuditBundle {
  /** Admin only. */
  list(opts?: {
    startTime?: string;
    endTime?: string;
    opTypes?: string[] | string;
  }): Promise<any[]>;
  /** Admin only. */
  listPage(opts?: AuditPageOptions): Promise<Page>;
  /** Admin only. */
  iterPages(opts?: {
    startTime?: string;
    endTime?: string;
    opTypes?: string[] | string;
    pageSize?: number;
  }): AsyncGenerator<any[]>;
  /** With projectId, open to that project's maintainers; without one, admin only. */
  tally(opts?: {
    projectId?: string;
    startTime?: string;
    endTime?: string;
    daily?: boolean;
  }): Promise<ActivityTallyRow[]>;
}

interface InvitesBundle {
  list(opts?: { projectId?: string; all?: boolean }): Promise<Invite[]>;
  listPage(opts?: {
    projectId?: string;
    all?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<Page>;
  iterPages(opts?: {
    projectId?: string;
    all?: boolean;
    pageSize?: number;
  }): AsyncGenerator<Invite[]>;
  /** The `code` is returned ONCE and is not recoverable afterward. */
  create(
    opts?: CreateInviteOptions,
    auditMessage?: string,
  ): Promise<Invite & { code: string }>;
  revoke(id: string, auditMessage?: string): Promise<any>;
}

interface TokenLayersBundle {
  shift(
    tokenLayerId: string,
    direction: string,
    auditMessage?: string,
  ): Promise<any>;
  create(
    textLayerId: string,
    name: string,
    overlapMode?: string,
    parentTokenLayerId?: string,
    auditMessage?: string,
  ): Promise<any>;
  setConfig(
    tokenLayerId: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    tokenLayerId: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  get(tokenLayerId: string, asOf?: string): Promise<any>;
  delete(tokenLayerId: string, auditMessage?: string): Promise<any>;
  update(
    tokenLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
}

/** Handle passed to a `documents.locked()` block. */
export declare class DocumentLock {
  readonly documentId: string;
  /** The DocumentLockLost if the lock lapsed, else null. */
  readonly lost: DocumentLockLost | null;
  /** Throw if the lock lapsed; call it between steps that have not written. */
  raiseIfLost(): void;
}

/** The lock a `documents.locked()` block was holding is no longer held. */
export declare class DocumentLockLost extends Error {
  readonly name: "DocumentLockLost";
  readonly documentId: string;
  readonly cause?: unknown;
}

/** The server's default document-lock window, in ms. */
export const DOCUMENT_LOCK_TTL_MS: 60000;

interface DocumentsBundle {
  checkLock(documentId: string, asOf?: string): Promise<any>;
  acquireLock(documentId: string, auditMessage?: string): Promise<any>;
  releaseLock(documentId: string, auditMessage?: string): Promise<any>;
  /**
   * Hold the document's lock for the length of `fn`, renewing it while `fn`
   * runs and releasing it on the way out. Rejects with a 423 if another user
   * holds it, and with DocumentLockLost if a renewal fails.
   */
  locked<T>(
    documentId: string,
    fn: (lock: DocumentLock) => T | Promise<T>,
    options?: { keepAlive?: boolean },
  ): Promise<T>;
  getMedia(documentId: string): Promise<ArrayBuffer>;
  uploadMedia(
    documentId: string,
    file: File,
    auditMessage?: string,
    options?: {
      /** Called with the bytes sent so far as the file goes up (`total` is null when unknown). */
      onProgress?: (progress: { loaded: number; total: number | null }) => void;
    },
  ): Promise<any>;
  deleteMedia(documentId: string, auditMessage?: string): Promise<any>;
  setMetadata(
    documentId: string,
    body: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteMetadata(documentId: string, auditMessage?: string): Promise<any>;
  patchMetadata(
    documentId: string,
    body: MetadataOp[],
    auditMessage?: string,
  ): Promise<any>;
  audit(
    documentId: string,
    startTime?: string,
    endTime?: string,
    asOf?: string,
  ): Promise<any[]>;
  auditPage(documentId: string, opts?: AuditPageOptions): Promise<Page>;
  get(documentId: string, includeBody?: boolean, asOf?: string): Promise<any>;
  delete(documentId: string, auditMessage?: string): Promise<any>;
  update(documentId: string, name: string, auditMessage?: string): Promise<any>;
  create(
    projectId: string,
    name: string,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  /** Copy a document and everything in it into a new document of the same project. */
  copy(
    documentId: string,
    name: string,
    options?: { includeMedia?: boolean },
    auditMessage?: string,
  ): Promise<{ id: string; mediaError?: string }>;
  restore(
    documentId: string,
    asOf: string,
    options?: { dryRun?: boolean },
    auditMessage?: string,
  ): Promise<any>;
}

interface MessagesBundle {
  sendMessage(
    projectId: string,
    data: any,
    auditMessage?: string,
  ): Promise<any>;
  listen(
    projectId: string,
    onEvent: (eventType: string, data: any) => void | boolean,
    path?: string,
  ): SSEConnection;
  /** Discover the services seen on a project: online ones plus previously-seen offline ones (check `online`). */
  discoverServices(projectId: string): Promise<DiscoveredService[]>;
  /** Forget a previously-seen (offline) service. Maintainer-only; 409 if currently connected. */
  discardService(projectId: string, serviceId: string): Promise<void>;
  /**
   * Register as a service and handle work requests. The registration reopens
   * its channel whenever it drops, so a server restart needs no service restart.
   */
  serve(
    projectId: string,
    serviceInfo: ServiceInfo,
    onServiceRequest: (data: any, responseHelper: ResponseHelper) => void,
    extras?: any,
    onStatus?: (
      event: ServiceStatusEvent,
      projectId: string,
      detail?: string,
    ) => void,
  ): ServiceRegistration;
  /**
   * Submit work to a service; streams progress to `onProgress`, resolves with
   * the result. Aborting `signal` stops waiting and rejects with an AbortError;
   * the service is not told and finishes its work regardless.
   */
  requestService(
    projectId: string,
    serviceId: string,
    data: any,
    timeout?: number,
    onProgress?: (progress: any) => void,
    signal?: AbortSignal,
    opts?: {
      /** A request id you mint, so you know it before submitting; resubmitting one rejoins that request. */
      requestId?: string;
      /** Called with the request id as soon as the server has taken the request. */
      onAccepted?: (requestId: string) => void;
    },
  ): Promise<any>;
  /**
   * Rejoin a request made earlier: the latest progress is replayed, then the
   * result, or at once if it already finished. Only its submitter (or an
   * admin). Rejects with a 404 when the request is unknown or expired.
   */
  attachServiceRequest(
    projectId: string,
    requestId: string,
    timeout?: number,
    onProgress?: (progress: any) => void,
    signal?: AbortSignal,
  ): Promise<any>;
  /**
   * Ask the service to stop a request made earlier. The request still ends
   * with whatever the service then reports. 404 if unknown or expired, 409
   * once finished.
   */
  cancelServiceRequest(projectId: string, requestId: string): Promise<void>;
}

interface ProjectsBundle {
  addWriter(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeWriter(id: string, userId: string, auditMessage?: string): Promise<any>;
  addReader(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeReader(id: string, userId: string, auditMessage?: string): Promise<any>;
  setConfig(
    id: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    id: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  addMaintainer(
    id: string,
    userId: string,
    auditMessage?: string,
  ): Promise<any>;
  removeMaintainer(
    id: string,
    userId: string,
    auditMessage?: string,
  ): Promise<any>;
  audit(
    projectId: string,
    startTime?: string,
    endTime?: string,
    asOf?: string,
  ): Promise<any[]>;
  auditPage(projectId: string, opts?: AuditPageOptions): Promise<Page>;
  /**
   * When the calling user last wrote to each document of the project, as a
   * `{documentId: timestamp}` map; documents they never wrote to are absent.
   * The keys are document ids, so the response is not key-transformed.
   */
  myLastEdits(projectId: string): Promise<Record<string, string>>;
  linkVocab(id: string, vocabId: string, auditMessage?: string): Promise<any>;
  unlinkVocab(id: string, vocabId: string, auditMessage?: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  listDocuments(id: string): Promise<any[]>;
  listDocumentsPage(
    id: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<Page>;
  iterDocuments(
    id: string,
    opts?: { pageSize?: number },
  ): AsyncGenerator<any[]>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, name: string, auditMessage?: string): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: {
    limit?: number;
    cursor?: string;
    asOf?: string;
  }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string, auditMessage?: string): Promise<any>;
}

interface TextLayersBundle {
  setConfig(
    textLayerId: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    textLayerId: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  get(textLayerId: string, asOf?: string): Promise<any>;
  delete(textLayerId: string, auditMessage?: string): Promise<any>;
  update(
    textLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
  shift(
    textLayerId: string,
    direction: string,
    auditMessage?: string,
  ): Promise<any>;
  create(projectId: string, name: string, auditMessage?: string): Promise<any>;
}

interface VocabItemsBundle {
  setMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(id: string, auditMessage?: string): Promise<any>;
  patchMetadata(id: string, body: MetadataOp[], auditMessage?: string): Promise<any>;
  create(
    vocabLayerId: string,
    form: string,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  bulkUpdate(body: any[], auditMessage?: string): Promise<{ count: number }>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, form: string, auditMessage?: string): Promise<any>;
}

interface RelationLayersBundle {
  shift(
    relationLayerId: string,
    direction: string,
    auditMessage?: string,
  ): Promise<any>;
  create(
    spanLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
  setConfig(
    relationLayerId: string,
    namespace: string,
    configKey: string,
    configValue: any,
    auditMessage?: string,
  ): Promise<any>;
  deleteConfig(
    relationLayerId: string,
    namespace: string,
    configKey: string,
    auditMessage?: string,
  ): Promise<any>;
  get(relationLayerId: string, asOf?: string): Promise<any>;
  delete(relationLayerId: string, auditMessage?: string): Promise<any>;
  update(
    relationLayerId: string,
    name: string,
    auditMessage?: string,
  ): Promise<any>;
}

interface TokensBundle {
  create(
    tokenLayerId: string,
    text: string,
    begin: number,
    end: number,
    precedence?: number | null,
    metadata?: any,
    auditMessage?: string,
  ): Promise<any>;
  get(tokenId: string, asOf?: string): Promise<any>;
  delete(tokenId: string, auditMessage?: string): Promise<any>;
  update(
    tokenId: string,
    begin?: number,
    end?: number,
    precedence?: number | null,
    auditMessage?: string,
  ): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  bulkUpdate(body: any[], auditMessage?: string): Promise<{ count: number }>;
  split(tokenId: string, position: number, auditMessage?: string): Promise<any>;
  merge(
    tokenId: string,
    otherTokenId: string,
    auditMessage?: string,
  ): Promise<any>;
  shift(
    tokenId: string,
    begin?: number,
    end?: number,
    auditMessage?: string,
  ): Promise<any>;
  setMetadata(tokenId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(tokenId: string, auditMessage?: string): Promise<any>;
  patchMetadata(
    tokenId: string,
    body: MetadataOp[],
    auditMessage?: string,
  ): Promise<any>;
}

interface PlaidClientOptions {
  /** Per-request timeout in ms (default 30000; 0 or null disables it). */
  timeout?: number | null;
  /**
   * Timeout for batch submissions in ms (default 180000; 0 or null disables it).
   * Batches get their own, longer budget: aborting one does NOT stop the
   * server, which keeps running the transaction and holding the single SQLite
   * write lock. Defaults to `timeout` when that is given and this is not.
   */
  batchTimeout?: number | null;
  /**
   * Fired once when a request returns HTTP 401 (missing/expired/invalid token).
   * Use it to discard the stored token and route back to login. 403 (forbidden)
   * does NOT trigger it.
   */
  onAuthError?: ((error: Error) => void) | null;
}

export interface OperationGroupsBundle {
  get(id: string): Promise<any>;
  update(id: string, message: string | null): Promise<any>;
}

/**
 * A batch: the client's bundles, on which every write of project data queues
 * until `submit()`. See `PlaidClient.batch()`.
 */
export interface PlaidBatch extends PlaidClient {
  /** The client this batch was opened on. */
  readonly client: PlaidClient;
  /** The queued operations, in order. */
  readonly operations: Array<{ path: string; method: string; body?: any }>;
  /** Send the queued operations as one atomic request; one result per operation. */
  submit(): Promise<any[]>;
  /** Drop the queued operations without sending them. */
  abort(): void;
}

export declare class PlaidClient {
  constructor(baseUrl: string, token: string, options?: PlaidClientOptions);
  static login(
    baseUrl: string,
    userId: string,
    password: string,
    options?: PlaidClientOptions,
  ): Promise<PlaidClient>;
  /** Build the link to hand someone for an invite code. */
  static inviteUrl(appUrl: string, code: string): string;
  /** Describe an invite code with no authentication (for a signup page). */
  static lookupInvite(
    baseUrl: string,
    code: string,
    options?: PlaidClientOptions,
  ): Promise<InvitePreview>;
  /** Redeem an invite code with no authentication; resolves to a logged-in client. */
  static redeemInvite(
    baseUrl: string,
    code: string,
    credentials: { email?: string; password: string; displayName?: string },
    options?: PlaidClientOptions,
  ): Promise<{ client: PlaidClient; userId: string; kind: string }>;
  /** The server's base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The bearer token every request carries. */
  token: string;
  timeout: number | null;
  batchTimeout: number | null;
  /** The document strict mode is entered for, or null. */
  readonly strictModeDocumentId: string | null;
  /** The DocumentLockLost of the most recent `locked()` block that lost its lock, or null. */
  documentLockLost: DocumentLockLost | null;
  /** Fired once on HTTP 401 (see PlaidClientOptions.onAuthError). */
  onAuthError: ((error: Error) => void) | null;
  /** The latest version seen for each document written through this client, keyed by document id. */
  documentVersions: Record<string, number>;

  // Batches.
  //
  // A batch is a view of the client with the same bundles. A write of project
  // data made on the batch queues; a call made on the client itself always
  // goes over the wire, whatever batches are open, so a write by code that
  // knows nothing about a batch can never land inside it. A read, or a signal
  // that carries no project data (stopping a service request, a service
  // reporting its progress, taking and dropping a document lock, the admin
  // actions on the server itself), goes over the wire even when made on the
  // batch.
  /** Open a batch. Queue writes on it, then `submit()` them as one atomic request, or `abort()`. Not nestable. */
  batch(): PlaidBatch;
  /** Run `fn` with a batch, then submit atomically (or abort if `fn` throws). Resolves to the results array, one entry per queued write. */
  batched(fn: (batch: PlaidBatch) => void | Promise<void>): Promise<any[]>;

  // Strict mode methods
  enterStrictMode(documentId: string): void;
  exitStrictMode(): void;

  // Logical operations (audit-log grouping). While one is open every write is
  // stamped with its group id so the audit log folds them into one entry.
  // Not atomic; nesting flattens into the outer operation.
  operationGroup: { id: string; message: string | null } | null;
  beginOperation(message: string, opts?: { id?: string }): string;
  endOperation(message?: string): Promise<void>;
  withOperation<T>(
    message: string,
    fn: (setMessage: (msg: string) => void) => Promise<T> | T,
  ): Promise<T>;
  operationGroups: OperationGroupsBundle;

  // Query
  query(body: any, auditMessage?: string): Promise<any>;

  vocabLinks: VocabLinksBundle;
  vocabLayers: VocabLayersBundle;
  relations: RelationsBundle;
  spanLayers: SpanLayersBundle;
  spans: SpansBundle;
  texts: TextsBundle;
  users: UsersBundle;
  apiTokens: ApiTokensBundle;
  userData: UserDataBundle;
  invites: InvitesBundle;
  server: ServerBundle;
  admin: AdminBundle;
  audit: AuditBundle;
  comments: CommentsBundle;
  guidelines: GuidelinesBundle;
  tokenLayers: TokenLayersBundle;
  documents: DocumentsBundle;
  messages: MessagesBundle;
  projects: ProjectsBundle;
  textLayers: TextLayersBundle;
  vocabItems: VocabItemsBundle;
  relationLayers: RelationLayersBundle;
  tokens: TokensBundle;
}

export default PlaidClient;

// --- Unicode code-point helpers for text offsets ---------------------------
// Token begin/end offsets are 0-based Unicode code-point indices (not UTF-16).
/** Number of Unicode code points in `s` (not `s.length`). */
export function cpLength(s: string): number;
/** Substring of `s` by code-point indices [begin, end) (end optional). */
export function cpSlice(s: string, begin: number, end?: number): string;
/** Prebuilt slicer for many code-point slices of one string (spreads once). */
export function cpSlicer(s: string): (begin: number, end?: number) => string;
/** UTF-16 index -> code-point index in `s`. */
export function utf16ToCp(s: string, u: number): number;
/** Code-point index -> UTF-16 index in `s` (clamps past the end). */
export function cpToUtf16(s: string, cp: number): number;
/** Like indexOf, but the result and `fromCp` are code-point indices; -1 if absent. */
export function cpIndexOf(s: string, sub: string, fromCp?: number): number;

// --- Shared layer-role vocabulary (cross-app interoperability) --------------
// Substrate layers are tagged with a role at `config.plaid.role` (a scalar) so
// that different apps can share a project. See the manual, "Layer Interoperability".
/** The reserved config namespace for cross-app conventions. */
export const PLAID_NAMESPACE: "plaid";
/** The config key, under `plaid`, holding a layer's role. */
export const ROLE_KEY: "role";
/** Layer config key naming the metadata keys a token born of a SPLIT inherits. */
export const PRESERVE_ON_SPLIT_KEY: "preserveOnSplit";

/** The server's cap on operations per batch request; a larger batch goes as consecutive requests. */
export const MAX_BATCH_OPS: 1000;
/** The fixed role inventory; only these values are interoperable across apps. */
export const ROLES: {
  readonly BASELINE: "baseline";
  readonly SENTENCE: "sentence";
  readonly WORD: "word";
  readonly SYNTACTIC_WORD: "syntactic-word";
  readonly MORPHEME: "morpheme";
  readonly TIME_ALIGNMENT: "time-alignment";
};
/** The role recorded on a layer's `config`, or null if none. */
export function readRole(config?: object): string | null;
/** The first layer in `layers` carrying the given role, or null. */
export function findByRole<T extends { config?: object }>(
  layers: T[] | undefined,
  role: string,
): T | null;

// --- Service self-description helpers ----------------------------------------
// Standardize how a service advertises (in `extras`) the tasks it serves, a
// summary, and a parameter schema — so a UI can offer service selection, an
// argument form, and a summary at a fixed integration point. See the manual,
// "Describing a service".
/** The controlled task vocabulary — the fixed integration-point goals. */
export const TASKS: {
  readonly TOKENIZE: "tokenize";
  readonly PARSE: "parse";
  readonly TRANSCRIBE: "transcribe";
  readonly LINK_VOCAB: "link-vocab";
  readonly ANALYZE: "analyze";
  readonly DRAFT_GRAPH: "draft-graph";
  readonly TRANSLATE: "translate";
  readonly ASSIST: "assist";
  readonly DETECT_SPEECH: "detect-speech";
  readonly COMPARE: "compare";
};
/** Whether a service serves a task (declared `extras.tasks`, legacy id-prefix fallback). */
export function servesTask(service: DiscoveredService, task: string): boolean;
/** The discovered services that serve `task`. */
export function filterServicesByTask(
  services: DiscoveredService[] | undefined,
  task: string,
): DiscoveredService[];
/** The parameter schema a service declares (ordered), or []. */
export function getParamSchema(service: DiscoveredService): ServiceParam[];
/** A service's human summary: `extras.summary`, else `description`, else ''. */
export function getServiceSummary(service: DiscoveredService): string;
/** Default form values keyed by param key. */
export function buildDefaultValues(schema: ServiceParam[]): Record<string, any>;
/** Coerce/validate raw form values against the schema. */
export function coerceParamValues(
  schema: ServiceParam[],
  raw: Record<string, any>,
): { values: Record<string, any>; errors: Record<string, string> };

// --- Provenance ---------------------------------------------------------------
// Cross-app convention for machine-provided vs human-labeled information,
// expressed as flat metadata keys on annotation entities. Absent keys = human;
// { prov: 'inferred', provSource } = machine-made, unverified;
// + { provConfirmed: true } = machine-made, human-verified. Machine writers may
// replace unverified machine material but must never touch human/verified
// material without an explicit overwrite opt-in; any human edit verifies.
// See the manual, "Provenance".
type ProvState = "human" | "machine" | "contributed" | "verified";
export const PROV: {
  readonly key: "prov";
  readonly sourceKey: "provSource";
  readonly confirmedKey: "provConfirmed";
  readonly probKey: "provProb";
  readonly detailKey: "provDetail";
  readonly INFERRED: "inferred";
  readonly CONTRIBUTED: "contributed";
};
export const PROV_STATES: {
  readonly HUMAN: "human";
  readonly MACHINE: "machine";
  readonly CONTRIBUTED: "contributed";
  readonly VERIFIED: "verified";
};
/** The provenance keys Plaid itself owns — what a split carries and a reshape keeps. */
export const PROVENANCE_KEYS: readonly string[];
/** Optional prediction extras: prob = a probability in [0,1] for the chosen value
 * (flat + queryable; omit unless it honestly is one); detail = an open map of
 * producer extras (top-k alternatives, model version, raw scores; keep it small).
 * Both describe the ORIGINAL prediction — check provConfirmed before presenting
 * provProb as confidence in the current value. */
interface ProvExtras {
  prob?: number;
  detail?: Record<string, any>;
}
/** The metadata fragment a machine writer merges into everything it creates. */
export function stampInferred(
  source: string,
  extras?: ProvExtras,
): {
  prov: "inferred";
  provSource: string;
  provProb?: number;
  provDetail?: Record<string, any>;
};
/** stampInferred + provConfirmed — for machine material born verified (e.g. imports with upstream approval). */
export function confirmedInferred(
  source: string,
  extras?: ProvExtras,
): {
  prov: "inferred";
  provSource: string;
  provConfirmed: true;
  provProb?: number;
  provDetail?: Record<string, any>;
};
/** Classify an entity's metadata into one of the three provenance states. */
export function provState(metadata: object | null | undefined): ProvState;
/** The verifying fragment, { provConfirmed: true }: PATCH it over existing metadata. */
export const PROV_CONFIRMED: { readonly provConfirmed: true };
/** Machine-made and not yet human-verified (needs review, replaceable, confirmable). */
export function isMachine(metadata: object | null | undefined): boolean;
/** Whether a machine writer must leave this entity alone (human or verified). !isMachine. */
export function isProtected(metadata: object | null | undefined): boolean;
/** The fragment a HUMAN edit should merge in: PROV_CONFIRMED iff machine-unverified, else null. */
export function verifyOnEdit(
  metadata: object | null | undefined,
): { readonly provConfirmed: true } | null;
/** Canonical provSource for a service: 'service:<serviceId>'. */
export function serviceSource(serviceId: string): string;
/** Canonical provSource for a contributor: 'user:<userId>'. */
export function userSource(userId: string): string;
/** The metadata fragment a contributor's work carries. */
export function stampContributed(userId: string): {
  prov: "contributed";
  provSource: string;
};
/** Where an entity came from, confirmed or not: what a verified entity's tooltip needs. */
export function provOrigin(
  metadata: object | null | undefined,
): null | "inferred" | "contributed";
/** Whether a verifier still has to look at this entity: machine-made or contributed, unconfirmed. */
export function needsReview(metadata: object | null | undefined): boolean;
/** The fragment a CONTRIBUTOR's edit merges in: the contributed stamp, dropping any confirmation. */
export function contributeOnEdit(
  metadata: object | null | undefined,
  userId: string,
): { prov: "contributed"; provSource: string; provConfirmed: null };
/** Merge a fragment into a local copy, a null value deleting the key. Equivalent to applyMetadataOps(metadata, metadataOps(fragment)). Returns a new object. */
export function mergeMetadata(
  metadata: object | null | undefined,
  fragment: object | null | undefined,
): Record<string, any>;

// --- Metadata ops -------------------------------------------------------------
/** One metadata edit: the body of a metadata PATCH is a list of these. */
export type MetadataOp =
  | { op: "set"; path: string[]; value: any }
  | { op: "delete"; path: string[] };
/** The ops that set each top-level key of a fragment, a null value deleting it. */
export function metadataOps(
  fragment: object | null | undefined,
): MetadataOp[];
/** Apply ops to a local copy the way the server does. Returns a new object; throws where the server would refuse. */
export function applyMetadataOps(
  metadata: object | null | undefined,
  ops: MetadataOp[],
): Record<string, any>;

// --- Review: whose work is reviewed (a project-config norm) -------------------
/** The config key, under the `plaid` namespace, holding the review lists. */
export const REVIEW_KEY: "review";
/** The project roles a review list may name. */
export const PROJECT_ROLES: readonly ["reader", "writer", "maintainer"];
/** A project's review lists, normalized. */
export function readReview(config?: object | null): {
  users: string[];
  roles: string[];
};
/** A person's role in a project from its ACL lists; an admin with no entry is a maintainer. */
export function projectRole(
  project: object | null | undefined,
  userId: string | null | undefined,
  opts?: { isAdmin?: boolean },
): "maintainer" | "writer" | "reader" | null;
/** Whether this person's work is reviewed here: named in review.users, or holding a role in review.roles. */
export function isReviewed(
  project: object | null | undefined,
  userId: string | null | undefined,
  opts?: { isAdmin?: boolean },
): boolean;
/** The review lists with one person added to or removed from `users`. Pure. */
export function withReviewedUser(
  review: { users?: string[]; roles?: string[] } | null | undefined,
  userId: string,
  reviewed: boolean,
): { users: string[]; roles: string[] };
/** What one writer's writes carry and what their review gestures act on. */
export function writerPolicy(contributorId?: string | null): {
  readonly contributorId: string | null;
  readonly isContributor: boolean;
  /** The metadata a NEW entity carries: null for a verifier. */
  readonly createStamp: Record<string, any> | null;
  /** The fragment an EDIT merges, or null when there is nothing to merge. */
  readonly editStamp: (
    metadata: object | null | undefined,
  ) => Record<string, any> | null;
  /** The fragment an explicit confirm gesture merges, or null. */
  readonly confirmStamp: (
    metadata: object | null | undefined,
  ) => Record<string, any> | null;
  /** What an adopted suggestion is written with. */
  readonly adoptStamp: (
    source: string,
    detail?: Record<string, any>,
  ) => Record<string, any>;
  /** Whether this writer's review gesture acts on the entity. */
  readonly reviewable: (metadata: object | null | undefined) => boolean;
  /** The same test over a provState. */
  readonly reviewableState: (state: string) => boolean;
};
