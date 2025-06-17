interface RelationsBundle {
  target(relationId: string, spanId: string): Promise<any>;
  get(relationId: string, asOf?: string): Promise<any>;
  delete(relationId: string): Promise<any>;
  update(relationId: string, value: any): Promise<any>;
  source(relationId: string, spanId: string): Promise<any>;
  create(layerId: string, sourceId: string, targetId: string, value: any): Promise<any>;
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
  tokens(spanId: string, tokens: any[]): Promise<any>;
  create(spanLayerId: string, tokens: any[], value: any, metadata?: any): Promise<any>;
  get(spanId: string, asOf?: string): Promise<any>;
  delete(spanId: string): Promise<any>;
  update(spanId: string, value: any): Promise<any>;
  metadata(spanId: string, body: any): Promise<any>;
  metadata(spanId: string): Promise<any>;
}

interface TextsBundle {
  create(textLayerId: string, documentId: string, body: string): Promise<any>;
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
  audit(documentId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any>;
  get(documentId: string, includeBody?: boolean, asOf?: string): Promise<any>;
  delete(documentId: string): Promise<any>;
  update(documentId: string, name: string): Promise<any>;
  create(projectId: string, name: string): Promise<any>;
}

interface ProjectsBundle {
  addWriter(id: string, userId: string): Promise<any>;
  removeWriter(id: string, userId: string): Promise<any>;
  addReader(id: string, userId: string): Promise<any>;
  removeReader(id: string, userId: string): Promise<any>;
  addMaintainer(id: string, userId: string): Promise<any>;
  removeMaintainer(id: string, userId: string): Promise<any>;
  audit(projectId: string, startTime?: string, endTime?: string, asOf?: string): Promise<any>;
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
  create(username: string, password: string): Promise<any>;
}

interface BulkBundle {
  submit(operations: any[]): Promise<any>;
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
  create(tokenLayerId: string, textId: string, begin: number, end: number, precedence?: number): Promise<any>;
  get(tokenId: string, asOf?: string): Promise<any>;
  delete(tokenId: string): Promise<any>;
  update(tokenId: string, begin?: number, end?: number, precedence?: number): Promise<any>;
}

declare class PlaidClient {
  constructor(baseUrl: string, token: string);
  relations: RelationsBundle;
  spanLayers: SpanLayersBundle;
  spans: SpansBundle;
  texts: TextsBundle;
  users: UsersBundle;
  tokenLayers: TokenLayersBundle;
  documents: DocumentsBundle;
  projects: ProjectsBundle;
  textLayers: TextLayersBundle;
  login: LoginBundle;
  bulk: BulkBundle;
  relationLayers: RelationLayersBundle;
  tokens: TokensBundle;
}

declare const client: PlaidClient;
