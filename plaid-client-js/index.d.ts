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
  type: 'string' | 'number' | 'boolean' | 'enum' | 'multiselect';
  description?: string;
  default?: any;
  required?: boolean;
  /** Required for `enum` / `multiselect`. */
  options?: ServiceParamOption[];
  /** `number` only. */
  min?: number;
  max?: number;
  step?: number;
  /** `string` only. */
  placeholder?: string;
  multiline?: boolean;
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
  isRunning(): boolean;
  serviceInfo: ServiceInfo & { extras: any };
}

interface ResponseHelper {
  progress(percent: number, message: string): void;
  complete(data: any): void;
  error(error: string | Error): void;
}

interface SSEConnection {
  close(): void;
  getStats(): any;
  readyState: number;
}

interface VocabLinksBundle {
  create(vocabItem: string, tokens: any[], metadata?: any, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  setMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(id: string, auditMessage?: string): Promise<any>;
  patchMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
}

interface VocabLayersBundle {
  get(id: string, includeItems?: boolean, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, name: string, auditMessage?: string): Promise<any>;
  setConfig(id: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string, auditMessage?: string): Promise<any>;
  addMaintainer(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeMaintainer(id: string, userId: string, auditMessage?: string): Promise<any>;
}

interface RelationsBundle {
  setMetadata(relationId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(relationId: string, auditMessage?: string): Promise<any>;
  patchMetadata(relationId: string, body: any, auditMessage?: string): Promise<any>;
  setTarget(relationId: string, spanId: string, auditMessage?: string): Promise<any>;
  get(relationId: string, asOf?: string): Promise<any>;
  delete(relationId: string, auditMessage?: string): Promise<any>;
  update(relationId: string, value: any, auditMessage?: string): Promise<any>;
  setSource(relationId: string, spanId: string, auditMessage?: string): Promise<any>;
  create(layerId: string, sourceId: string, targetId: string, value: any, metadata?: any, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
}

interface SpanLayersBundle {
  setConfig(spanLayerId: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(spanLayerId: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  get(spanLayerId: string, asOf?: string): Promise<any>;
  delete(spanLayerId: string, auditMessage?: string): Promise<any>;
  update(spanLayerId: string, name: string, auditMessage?: string): Promise<any>;
  create(tokenLayerId: string, name: string, auditMessage?: string): Promise<any>;
  shift(spanLayerId: string, direction: string, auditMessage?: string): Promise<any>;
}

interface SpansBundle {
  setTokens(spanId: string, tokens: any[], auditMessage?: string): Promise<any>;
  create(spanLayerId: string, tokens: any[], value: any, metadata?: any, auditMessage?: string): Promise<any>;
  get(spanId: string, asOf?: string): Promise<any>;
  delete(spanId: string, auditMessage?: string): Promise<any>;
  update(spanId: string, value: any, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  setMetadata(spanId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(spanId: string, auditMessage?: string): Promise<any>;
  patchMetadata(spanId: string, body: any, auditMessage?: string): Promise<any>;
}

interface BatchBundle {
  submit(body: any[], auditMessage?: string): Promise<any>;
}

interface TextsBundle {
  setMetadata(textId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(textId: string, auditMessage?: string): Promise<any>;
  patchMetadata(textId: string, body: any, auditMessage?: string): Promise<any>;
  create(textLayerId: string, documentId: string, body: string, metadata?: any, auditMessage?: string): Promise<any>;
  get(textId: string, asOf?: string): Promise<any>;
  delete(textId: string, auditMessage?: string): Promise<any>;
  update(textId: string, body: any, auditMessage?: string): Promise<any>;
}

interface UsersBundle {
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(email: string, password: string, isAdmin: boolean, displayName?: string, auditMessage?: string): Promise<any>;
  audit(userId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  activate(id: string, auditMessage?: string): Promise<any>;
  update(id: string, password?: string, displayName?: string, isAdmin?: boolean, auditMessage?: string): Promise<any>;
  /** URL for a user's profile picture, usable as an <img> src. Null when avatarHash is explicitly null. */
  avatarUrl(id: string, avatarHash?: string | null): string | null;
  getAvatar(id: string): Promise<any>;
  setAvatar(id: string, file: File | Blob, auditMessage?: string): Promise<any>;
  deleteAvatar(id: string, auditMessage?: string): Promise<any>;
}

interface ApiTokensBundle {
  list(userId: string): Promise<any[]>;
  listPage(userId: string, opts?: { limit?: number; cursor?: string }): Promise<Page>;
  iterPages(userId: string, opts?: { pageSize?: number }): AsyncGenerator<any[]>;
  create(userId: string, name: string, auditMessage?: string): Promise<{ id: string; name: string; token: string }>;
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

interface InvitesBundle {
  list(opts?: { projectId?: string }): Promise<Invite[]>;
  listPage(opts?: { projectId?: string; limit?: number; cursor?: string }): Promise<Page>;
  iterPages(opts?: { projectId?: string; pageSize?: number }): AsyncGenerator<Invite[]>;
  /** The `code` is returned ONCE and is not recoverable afterward. */
  create(opts?: CreateInviteOptions, auditMessage?: string): Promise<Invite & { code: string }>;
  revoke(id: string, auditMessage?: string): Promise<any>;
}

interface TokenLayersBundle {
  shift(tokenLayerId: string, direction: string, auditMessage?: string): Promise<any>;
  create(textLayerId: string, name: string, overlapMode?: string, parentTokenLayerId?: string, auditMessage?: string): Promise<any>;
  setConfig(tokenLayerId: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(tokenLayerId: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  get(tokenLayerId: string, asOf?: string): Promise<any>;
  delete(tokenLayerId: string, auditMessage?: string): Promise<any>;
  update(tokenLayerId: string, name: string, auditMessage?: string): Promise<any>;
}

interface DocumentsBundle {
  checkLock(documentId: string, asOf?: string): Promise<any>;
  acquireLock(documentId: string, auditMessage?: string): Promise<any>;
  releaseLock(documentId: string, auditMessage?: string): Promise<any>;
  getMedia(documentId: string, asOf?: string): Promise<ArrayBuffer>;
  uploadMedia(documentId: string, file: File, auditMessage?: string): Promise<any>;
  deleteMedia(documentId: string, auditMessage?: string): Promise<any>;
  setMetadata(documentId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(documentId: string, auditMessage?: string): Promise<any>;
  patchMetadata(documentId: string, body: any, auditMessage?: string): Promise<any>;
  audit(documentId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  get(documentId: string, includeBody?: boolean, asOf?: string): Promise<any>;
  delete(documentId: string, auditMessage?: string): Promise<any>;
  update(documentId: string, name: string, auditMessage?: string): Promise<any>;
  create(projectId: string, name: string, metadata?: any, auditMessage?: string): Promise<any>;
}

interface MessagesBundle {
  sendMessage(projectId: string, data: any, auditMessage?: string): Promise<any>;
  listen(projectId: string, onEvent: (eventType: string, data: any) => void | boolean, path?: string): SSEConnection;
  /** Discover the services seen on a project: online ones plus previously-seen offline ones (check `online`). */
  discoverServices(projectId: string): Promise<DiscoveredService[]>;
  /** Forget a previously-seen (offline) service. Maintainer-only; 409 if currently connected. */
  discardService(projectId: string, serviceId: string): Promise<void>;
  serve(projectId: string, serviceInfo: ServiceInfo, onServiceRequest: (data: any, responseHelper: ResponseHelper) => void, extras?: any): ServiceRegistration;
  /** Submit work to a service; streams progress to `onProgress`, resolves with the result. */
  requestService(projectId: string, serviceId: string, data: any, timeout?: number, onProgress?: (progress: any) => void): Promise<any>;
}

interface ProjectsBundle {
  addWriter(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeWriter(id: string, userId: string, auditMessage?: string): Promise<any>;
  addReader(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeReader(id: string, userId: string, auditMessage?: string): Promise<any>;
  setConfig(id: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  addMaintainer(id: string, userId: string, auditMessage?: string): Promise<any>;
  removeMaintainer(id: string, userId: string, auditMessage?: string): Promise<any>;
  audit(projectId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  linkVocab(id: string, vocabId: string, auditMessage?: string): Promise<any>;
  unlinkVocab(id: string, vocabId: string, auditMessage?: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  listDocuments(id: string): Promise<any[]>;
  listDocumentsPage(id: string, opts?: { limit?: number; cursor?: string }): Promise<Page>;
  iterDocuments(id: string, opts?: { pageSize?: number }): AsyncGenerator<any[]>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, name: string, auditMessage?: string): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string, auditMessage?: string): Promise<any>;
}

interface TextLayersBundle {
  setConfig(textLayerId: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(textLayerId: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  get(textLayerId: string, asOf?: string): Promise<any>;
  delete(textLayerId: string, auditMessage?: string): Promise<any>;
  update(textLayerId: string, name: string, auditMessage?: string): Promise<any>;
  shift(textLayerId: string, direction: string, auditMessage?: string): Promise<any>;
  create(projectId: string, name: string, auditMessage?: string): Promise<any>;
}

interface VocabItemsBundle {
  setMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(id: string, auditMessage?: string): Promise<any>;
  patchMetadata(id: string, body: any, auditMessage?: string): Promise<any>;
  create(vocabLayerId: string, form: string, metadata?: any, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string, auditMessage?: string): Promise<any>;
  update(id: string, form: string, auditMessage?: string): Promise<any>;
}

interface RelationLayersBundle {
  shift(relationLayerId: string, direction: string, auditMessage?: string): Promise<any>;
  create(spanLayerId: string, name: string, auditMessage?: string): Promise<any>;
  setConfig(relationLayerId: string, namespace: string, configKey: string, configValue: any, auditMessage?: string): Promise<any>;
  deleteConfig(relationLayerId: string, namespace: string, configKey: string, auditMessage?: string): Promise<any>;
  get(relationLayerId: string, asOf?: string): Promise<any>;
  delete(relationLayerId: string, auditMessage?: string): Promise<any>;
  update(relationLayerId: string, name: string, auditMessage?: string): Promise<any>;
}

interface TokensBundle {
  create(tokenLayerId: string, text: string, begin: number, end: number, precedence?: number | null, metadata?: any, auditMessage?: string): Promise<any>;
  get(tokenId: string, asOf?: string): Promise<any>;
  delete(tokenId: string, auditMessage?: string): Promise<any>;
  update(tokenId: string, begin?: number, end?: number, precedence?: number | null, auditMessage?: string): Promise<any>;
  bulkCreate(body: any[], auditMessage?: string): Promise<{ ids: string[] }>;
  bulkDelete(body: any[], auditMessage?: string): Promise<void>;
  split(tokenId: string, position: number, auditMessage?: string): Promise<any>;
  merge(tokenId: string, otherTokenId: string, auditMessage?: string): Promise<any>;
  shift(tokenId: string, begin?: number, end?: number, auditMessage?: string): Promise<any>;
  setMetadata(tokenId: string, body: any, auditMessage?: string): Promise<any>;
  deleteMetadata(tokenId: string, auditMessage?: string): Promise<any>;
  patchMetadata(tokenId: string, body: any, auditMessage?: string): Promise<any>;
}

interface PlaidClientOptions {
  /** Per-request timeout in ms (default 30000; 0 or null disables it). */
  timeout?: number | null;
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

export declare class PlaidClient {
  constructor(baseUrl: string, token: string, options?: PlaidClientOptions);
  static login(baseUrl: string, userId: string, password: string, options?: PlaidClientOptions): Promise<PlaidClient>;
  /** Build the link to hand someone for an invite code. */
  static inviteUrl(appUrl: string, code: string): string;
  /** Describe an invite code with no authentication (for a signup page). */
  static lookupInvite(baseUrl: string, code: string, options?: PlaidClientOptions): Promise<InvitePreview>;
  /** Redeem an invite code with no authentication; resolves to a logged-in client. */
  static redeemInvite(
    baseUrl: string,
    code: string,
    credentials: { email?: string; password: string; displayName?: string },
    options?: PlaidClientOptions,
  ): Promise<{ client: PlaidClient; userId: string; kind: string }>;
  timeout: number | null;
  /** Fired once on HTTP 401 (see PlaidClientOptions.onAuthError). */
  onAuthError: ((error: Error) => void) | null;

  // Batch control methods
  beginBatch(): void;
  submitBatch(): Promise<any[]>;
  abortBatch(): void;
  isBatchMode(): boolean;
  /** Run `fn` with a batch open, then submit atomically (or abort if `fn` throws). Resolves to the results array. */
  batched(fn: () => void | Promise<void>): Promise<any[]>;

  // Strict mode methods
  enterStrictMode(documentId: string): void;
  exitStrictMode(): void;

  // Logical operations (audit-log grouping). While one is open every write is
  // stamped with its group id so the audit log folds them into one entry.
  // Not atomic; nesting flattens into the outer operation.
  operationGroup: { id: string; message: string | null } | null;
  beginOperation(message: string, opts?: { id?: string }): string;
  endOperation(message?: string): Promise<void>;
  withOperation<T>(message: string, fn: (setMessage: (msg: string) => void) => Promise<T> | T): Promise<T>;
  operationGroups: OperationGroupsBundle;

  // Query
  query(body: any, auditMessage?: string): Promise<any>;

  vocabLinks: VocabLinksBundle;
  vocabLayers: VocabLayersBundle;
  relations: RelationsBundle;
  spanLayers: SpanLayersBundle;
  spans: SpansBundle;
  batch: BatchBundle;
  texts: TextsBundle;
  users: UsersBundle;
  apiTokens: ApiTokensBundle;
  invites: InvitesBundle;
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
export const PLAID_NAMESPACE: 'plaid';
/** The config key, under `plaid`, holding a layer's role. */
export const ROLE_KEY: 'role';
/** The fixed role inventory; only these values are interoperable across apps. */
export const ROLES: {
  readonly BASELINE: 'baseline';
  readonly SENTENCE: 'sentence';
  readonly WORD: 'word';
  readonly SYNTACTIC_WORD: 'syntactic-word';
  readonly MORPHEME: 'morpheme';
  readonly TIME_ALIGNMENT: 'time-alignment';
};
/** The role recorded on a layer's `config`, or null if none. */
export function readRole(config?: object): string | null;
/** The first layer in `layers` carrying the given role, or null. */
export function findByRole<T extends { config?: object }>(layers: T[] | undefined, role: string): T | null;

// --- Service self-description helpers ----------------------------------------
// Standardize how a service advertises (in `extras`) the tasks it serves, a
// summary, and a parameter schema — so a UI can offer service selection, an
// argument form, and a summary at a fixed integration point. See the manual,
// "Describing a service".
/** The controlled task vocabulary — the fixed integration-point goals. */
export const TASKS: {
  readonly TOKENIZE: 'tokenize';
  readonly PARSE: 'parse';
  readonly TRANSCRIBE: 'transcribe';
  readonly LINK_VOCAB: 'link-vocab';
  readonly ANALYZE: 'analyze';
};
/** Whether a service serves a task (declared `extras.tasks`, legacy id-prefix fallback). */
export function servesTask(service: DiscoveredService, task: string): boolean;
/** The discovered services that serve `task`. */
export function filterServicesByTask(services: DiscoveredService[] | undefined, task: string): DiscoveredService[];
/** The parameter schema a service declares (ordered), or []. */
export function getParamSchema(service: DiscoveredService): ServiceParam[];
/** A service's human summary: `extras.summary`, else `description`, else ''. */
export function getServiceSummary(service: DiscoveredService): string;
/** Default form values keyed by param key. */
export function buildDefaultValues(schema: ServiceParam[]): Record<string, any>;
/** Coerce/validate raw form values against the schema. */
export function coerceParamValues(schema: ServiceParam[], raw: Record<string, any>): { values: Record<string, any>; errors: Record<string, string> };

// --- Provenance ---------------------------------------------------------------
// Cross-app convention for machine-provided vs human-labeled information,
// expressed as flat metadata keys on annotation entities. Absent keys = human;
// { prov: 'inferred', provSource } = machine-made, unverified;
// + { provConfirmed: true } = machine-made, human-verified. Machine writers may
// replace unverified machine material but must never touch human/verified
// material without an explicit overwrite opt-in; any human edit verifies.
// See the manual, "Provenance".
type ProvState = 'human' | 'machine' | 'verified';
export const PROV: {
  readonly key: 'prov';
  readonly sourceKey: 'provSource';
  readonly confirmedKey: 'provConfirmed';
  readonly probKey: 'provProb';
  readonly detailKey: 'provDetail';
  readonly INFERRED: 'inferred';
};
export const PROV_STATES: {
  readonly HUMAN: 'human';
  readonly MACHINE: 'machine';
  readonly VERIFIED: 'verified';
};
/** Optional prediction extras: prob = a probability in [0,1] for the chosen value
 * (flat + queryable; omit unless it honestly is one); detail = an open map of
 * producer extras (top-k alternatives, model version, raw scores; keep it small).
 * Both describe the ORIGINAL prediction — check provConfirmed before presenting
 * provProb as confidence in the current value. */
interface ProvExtras { prob?: number; detail?: Record<string, any> }
/** The metadata fragment a machine writer merges into everything it creates. */
export function stampInferred(source: string, extras?: ProvExtras):
  { prov: 'inferred'; provSource: string; provProb?: number; provDetail?: Record<string, any> };
/** stampInferred + provConfirmed — for machine material born verified (e.g. imports with upstream approval). */
export function confirmedInferred(source: string, extras?: ProvExtras):
  { prov: 'inferred'; provSource: string; provConfirmed: true; provProb?: number; provDetail?: Record<string, any> };
/** Classify an entity's metadata into one of the three provenance states. */
export function provState(metadata: object | null | undefined): ProvState;
/** The verifying fragment, { provConfirmed: true }: PATCH it over existing metadata. */
export const PROV_CONFIRMED: { readonly provConfirmed: true };
/** Machine-made and not yet human-verified (needs review, replaceable, confirmable). */
export function isMachine(metadata: object | null | undefined): boolean;
/** Whether a machine writer must leave this entity alone (human or verified). !isMachine. */
export function isProtected(metadata: object | null | undefined): boolean;
/** The fragment a HUMAN edit should merge in: PROV_CONFIRMED iff machine-unverified, else null. */
export function verifyOnEdit(metadata: object | null | undefined): { readonly provConfirmed: true } | null;
/** Canonical provSource for a service: 'service:<serviceId>'. */
export function serviceSource(serviceId: string): string;
