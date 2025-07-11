interface VocabLinksBundle {
  create(vocabItem: string, tokens: any[], metadata?: any): Promise<any>;
  setMetadata(id: string, body: any): Promise<any>;
  deleteMetadata(id: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
}

interface VocabLayersBundle {
  get(id: string, includeItems?: boolean, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, name: string): Promise<any>;
  setConfig(id: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string): Promise<any>;
  list(asOf?: string): Promise<any>;
  create(name: string): Promise<any>;
  addMaintainer(id: string, userId: string): Promise<any>;
  removeMaintainer(id: string, userId: string): Promise<any>;
}

interface RelationsBundle {
  setMetadata(relationId: string, body: any): Promise<any>;
  deleteMetadata(relationId: string): Promise<any>;
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
}

interface BatchBundle {
  submit(body: any[]): Promise<any>;
}

interface TextsBundle {
  setMetadata(textId: string, body: any): Promise<any>;
  deleteMetadata(textId: string): Promise<any>;
  create(textLayerId: string, documentId: string, body: string, metadata?: any): Promise<any>;
  get(textId: string, asOf?: string): Promise<any>;
  delete(textId: string): Promise<any>;
  update(textId: string, body: string): Promise<any>;
}

interface UsersBundle {
  list(asOf?: string): Promise<any>;
  create(username: string, password: string, isAdmin: boolean): Promise<any>;
  audit(userId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any>;
  get(id: string, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, password?: string, username?: string, isAdmin?: boolean): Promise<any>;
}

interface TokenLayersBundle {
  shift(tokenLayerId: string, direction: string): Promise<any>;
  create(textLayerId: string, name: string): Promise<any>;
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
  setMetadata(documentId: string, body: any): Promise<any>;
  deleteMetadata(documentId: string): Promise<any>;
  audit(documentId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any>;
  get(documentId: string, includeBody?: boolean, asOf?: string): Promise<any>;
  delete(documentId: string): Promise<any>;
  update(documentId: string, name: string): Promise<any>;
  create(projectId: string, name: string, metadata?: any): Promise<any>;
}

interface ProjectsBundle {
  sendMessage(id: string, body: any): Promise<any>;
  addWriter(id: string, userId: string): Promise<any>;
  removeWriter(id: string, userId: string): Promise<any>;
  addReader(id: string, userId: string): Promise<any>;
  removeReader(id: string, userId: string): Promise<any>;
  heartbeat(id: string, clientId: string): Promise<any>;
  listen(id: string, onEvent: (eventType: string, data: any) => void): { close(): void; getStats(): any; readyState: number; };
  setConfig(id: string, namespace: string, configKey: string, configValue: any): Promise<any>;
  deleteConfig(id: string, namespace: string, configKey: string): Promise<any>;
  addMaintainer(id: string, userId: string): Promise<any>;
  removeMaintainer(id: string, userId: string): Promise<any>;
  audit(projectId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any>;
  linkVocab(id: string, vocabId: string): Promise<any>;
  unlinkVocab(id: string, vocabId: string): Promise<any>;
  get(id: string, includeDocuments?: boolean, asOf?: string): Promise<any>;
  delete(id: string): Promise<any>;
  update(id: string, name: string): Promise<any>;
  list(asOf?: string): Promise<any>;
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

interface LoginBundle {
  create(userId: string, password: string): Promise<any>;
}

interface VocabItemsBundle {
  setMetadata(id: string, body: any): Promise<any>;
  deleteMetadata(id: string): Promise<any>;
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
  create(tokenLayerId: string, text: string, begin: number, end: number, precedence?: number, metadata?: any): Promise<any>;
  get(tokenId: string, asOf?: string): Promise<any>;
  delete(tokenId: string): Promise<any>;
  update(tokenId: string, begin?: number, end?: number, precedence?: number): Promise<any>;
  bulkCreate(body: any[]): Promise<any>;
  bulkDelete(body: any[]): Promise<any>;
  setMetadata(tokenId: string, body: any): Promise<any>;
  deleteMetadata(tokenId: string): Promise<any>;
}

declare class PlaidClient {
  constructor(baseUrl: string, token: string);
  static login(baseUrl: string, userId: string, password: string): Promise<PlaidClient>;
  
  // Batch control methods
  beginBatch(): void;
  submitBatch(): Promise<any[]>;
  abortBatch(): void;
  isBatchMode(): boolean;
  
  // Strict mode methods
  enterStrictMode(documentId: string): void;
  exitStrictMode(): void;
  
  vocabLinks: VocabLinksBundle;
  vocabLayers: VocabLayersBundle;
  relations: RelationsBundle;
  spanLayers: SpanLayersBundle;
  spans: SpansBundle;
  batch: BatchBundle;
  texts: TextsBundle;
  users: UsersBundle;
  tokenLayers: TokenLayersBundle;
  documents: DocumentsBundle;
  projects: ProjectsBundle;
  textLayers: TextLayersBundle;
  login: LoginBundle;
  vocabItems: VocabItemsBundle;
  relationLayers: RelationLayersBundle;
  tokens: TokensBundle;
}

declare const client: PlaidClient;
