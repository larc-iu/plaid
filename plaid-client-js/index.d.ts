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
  create(vocabItem: string, tokens: any[], metadata?: any): Promise<any>;
  setMetadata(id: string, body: any): Promise<any>;
  deleteMetadata(id: string): Promise<any>;
  patchMetadata(id: string, body: any): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
}

interface VocabLayersBundle {
  get(id: string, includeItems?: boolean, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, name: string): Promise<any>;
  setConfig(id: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string): Promise<any>;
  addMaintainer(id: string, userId: string): Promise<any>;
  removeMaintainer(id: string, userId: string): Promise<any>;
}

interface RelationsBundle {
  setMetadata(relationId: string, body: any): Promise<any>;
  deleteMetadata(relationId: string): Promise<any>;
  patchMetadata(relationId: string, body: any): Promise<any>;
  setTarget(relationId: string, spanId: string): Promise<any>;
  get(relationId: string, asOf?: string): Promise<any>;
  delete(relationId: string): Promise<any>;
  update(relationId: string, value: any): Promise<any>;
  setSource(relationId: string, spanId: string): Promise<any>;
  create(layerId: string, sourceId: string, targetId: string, value: any, metadata?: any): Promise<any>;
  bulkCreate(body: any[]): Promise<any>;
  bulkDelete(body: any[]): Promise<any>;
}

interface SpanLayersBundle {
  setConfig(spanLayerId: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(spanLayerId: string, namespace: string, configKey: string): Promise<any>;
  get(spanLayerId: string, asOf?: string): Promise<any>;
  delete(spanLayerId: string): Promise<any>;
  update(spanLayerId: string, name: string): Promise<any>;
  create(tokenLayerId: string, name: string): Promise<any>;
  shift(spanLayerId: string, direction: string): Promise<any>;
}

interface SpansBundle {
  setTokens(spanId: string, tokens: any[]): Promise<any>;
  create(spanLayerId: string, tokens: any[], value: any, metadata?: any): Promise<any>;
  get(spanId: string, asOf?: string): Promise<any>;
  delete(spanId: string): Promise<any>;
  update(spanId: string, value: any): Promise<any>;
  bulkCreate(body: any[]): Promise<any>;
  bulkDelete(body: any[]): Promise<any>;
  setMetadata(spanId: string, body: any): Promise<any>;
  deleteMetadata(spanId: string): Promise<any>;
  patchMetadata(spanId: string, body: any): Promise<any>;
}

interface BatchBundle {
  submit(body: any[]): Promise<any>;
}

interface TextsBundle {
  setMetadata(textId: string, body: any): Promise<any>;
  deleteMetadata(textId: string): Promise<any>;
  patchMetadata(textId: string, body: any): Promise<any>;
  create(textLayerId: string, documentId: string, body: string, metadata?: any): Promise<any>;
  get(textId: string, asOf?: string): Promise<any>;
  delete(textId: string): Promise<any>;
  update(textId: string, body: any): Promise<any>;
}

interface UsersBundle {
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(username: string, password: string, isAdmin: boolean): Promise<any>;
  audit(userId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, password?: string, username?: string, isAdmin?: boolean): Promise<any>;
}

interface ApiTokensBundle {
  list(userId: string): Promise<any[]>;
  listPage(userId: string, opts?: { limit?: number; cursor?: string }): Promise<Page>;
  iterPages(userId: string, opts?: { pageSize?: number }): AsyncGenerator<any[]>;
  create(userId: string, name: string): Promise<{ id: string; name: string; token: string }>;
  revoke(userId: string, tokenId: string): Promise<any>;
}

interface TokenLayersBundle {
  shift(tokenLayerId: string, direction: string): Promise<any>;
  create(textLayerId: string, name: string, overlapMode?: string, parentTokenLayerId?: string): Promise<any>;
  setConfig(tokenLayerId: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(tokenLayerId: string, namespace: string, configKey: string): Promise<any>;
  get(tokenLayerId: string, asOf?: string): Promise<any>;
  delete(tokenLayerId: string): Promise<any>;
  update(tokenLayerId: string, name: string): Promise<any>;
}

interface DocumentsBundle {
  checkLock(documentId: string, asOf?: string): Promise<any>;
  acquireLock(documentId: string): Promise<any>;
  releaseLock(documentId: string): Promise<any>;
  getMedia(documentId: string, asOf?: string): Promise<ArrayBuffer>;
  uploadMedia(documentId: string, file: File): Promise<any>;
  deleteMedia(documentId: string): Promise<any>;
  setMetadata(documentId: string, body: any): Promise<any>;
  deleteMetadata(documentId: string): Promise<any>;
  patchMetadata(documentId: string, body: any): Promise<any>;
  audit(documentId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  get(documentId: string, includeBody?: boolean, asOf?: string): Promise<any>;
  delete(documentId: string): Promise<any>;
  update(documentId: string, name: string): Promise<any>;
  create(projectId: string, name: string, metadata?: any): Promise<any>;
}

interface MessagesBundle {
  sendMessage(projectId: string, data: any): Promise<any>;
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
  addWriter(id: string, userId: string): Promise<any>;
  removeWriter(id: string, userId: string): Promise<any>;
  addReader(id: string, userId: string): Promise<any>;
  removeReader(id: string, userId: string): Promise<any>;
  setConfig(id: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string): Promise<any>;
  addMaintainer(id: string, userId: string): Promise<any>;
  removeMaintainer(id: string, userId: string): Promise<any>;
  audit(projectId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any[]>;
  linkVocab(id: string, vocabId: string): Promise<any>;
  unlinkVocab(id: string, vocabId: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  listDocuments(id: string): Promise<any[]>;
  listDocumentsPage(id: string, opts?: { limit?: number; cursor?: string }): Promise<Page>;
  iterDocuments(id: string, opts?: { pageSize?: number }): AsyncGenerator<any[]>;
  delete(id: string): Promise<any>;
  update(id: string, name: string): Promise<any>;
  list(asOf?: string): Promise<any[]>;
  listPage(opts?: { limit?: number; cursor?: string; asOf?: string }): Promise<Page>;
  iterPages(opts?: { pageSize?: number; asOf?: string }): AsyncGenerator<any[]>;
  create(name: string): Promise<any>;
}

interface TextLayersBundle {
  setConfig(textLayerId: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(textLayerId: string, namespace: string, configKey: string): Promise<any>;
  get(textLayerId: string, asOf?: string): Promise<any>;
  delete(textLayerId: string): Promise<any>;
  update(textLayerId: string, name: string): Promise<any>;
  shift(textLayerId: string, direction: string): Promise<any>;
  create(projectId: string, name: string): Promise<any>;
}

interface VocabItemsBundle {
  setMetadata(id: string, body: any): Promise<any>;
  deleteMetadata(id: string): Promise<any>;
  patchMetadata(id: string, body: any): Promise<any>;
  create(vocabLayerId: string, form: string, metadata?: any): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, form: string): Promise<any>;
}

interface RelationLayersBundle {
  shift(relationLayerId: string, direction: string): Promise<any>;
  create(spanLayerId: string, name: string): Promise<any>;
  setConfig(relationLayerId: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(relationLayerId: string, namespace: string, configKey: string): Promise<any>;
  get(relationLayerId: string, asOf?: string): Promise<any>;
  delete(relationLayerId: string): Promise<any>;
  update(relationLayerId: string, name: string): Promise<any>;
}

interface TokensBundle {
  create(tokenLayerId: string, text: string, begin: number, end: number, precedence?: number | null, metadata?: any): Promise<any>;
  get(tokenId: string, asOf?: string): Promise<any>;
  delete(tokenId: string): Promise<any>;
  update(tokenId: string, begin?: number, end?: number, precedence?: number | null): Promise<any>;
  bulkCreate(body: any[]): Promise<any>;
  bulkDelete(body: any[]): Promise<any>;
  split(tokenId: string, position: number): Promise<any>;
  merge(tokenId: string, otherTokenId: string): Promise<any>;
  shift(tokenId: string, begin?: number, end?: number): Promise<any>;
  setMetadata(tokenId: string, body: any): Promise<any>;
  deleteMetadata(tokenId: string): Promise<any>;
  patchMetadata(tokenId: string, body: any): Promise<any>;
}

interface PlaidClientOptions {
  /** Per-request timeout in ms (default 30000; 0 or null disables it). */
  timeout?: number | null;
}

export declare class PlaidClient {
  constructor(baseUrl: string, token: string, options?: PlaidClientOptions);
  static login(baseUrl: string, userId: string, password: string, options?: PlaidClientOptions): Promise<PlaidClient>;
  timeout: number | null;

  // Batch control methods
  beginBatch(): void;
  submitBatch(): Promise<any[]>;
  abortBatch(): void;
  isBatchMode(): boolean;

  // Strict mode methods
  enterStrictMode(documentId: string): void;
  exitStrictMode(): void;

  // Custom audit-log message (overrides the auto-generated description; may
  // template the endpoint's path/query/body params with {param} placeholders).
  auditMessage: string | null;
  setAuditMessage(message: string): this;
  clearAuditMessage(): this;
  withAuditMessage<T>(message: string, fn: () => Promise<T> | T): Promise<T>;

  // Query
  query(body: any): Promise<any>;

  vocabLinks: VocabLinksBundle;
  vocabLayers: VocabLayersBundle;
  relations: RelationsBundle;
  spanLayers: SpanLayersBundle;
  spans: SpansBundle;
  batch: BatchBundle;
  texts: TextsBundle;
  users: UsersBundle;
  apiTokens: ApiTokensBundle;
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
/** Whether a machine writer must leave this entity alone (human or verified). */
export function isProtected(metadata: object | null | undefined): boolean;
/** The fragment a HUMAN edit should merge in: { provConfirmed: true } iff machine-unverified, else null. */
export function verifyOnEdit(metadata: object | null | undefined): { provConfirmed: true } | null;
/** Canonical provSource for a service: 'service:<serviceId>'. */
export function serviceSource(serviceId: string): string;
