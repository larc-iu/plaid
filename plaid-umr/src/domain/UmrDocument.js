// A UMR document: the lifecycle is plaid-ui's DocumentModel, what the layers
// mean is here. Reads only in phase 1; the editing methods arrive with the
// canvas.
//
// By their real paths rather than through `@ui`: the node suite has no alias.
import { DocumentModel } from '../../../plaid-ui/src/domain/DocumentModel.js';
import { getUmrLayerInfo } from '../utils/umrLayerUtils.js';
import { buildDocumentGraph, toUmrSentences } from './sentenceGraph.js';
import { serializeUmrFile } from './format/umrFile.js';
import { validateDocument } from './format/validate.js';

export class UmrDocument extends DocumentModel {
  constructor({ raw, client = null, projectId = null, project = null, user = null, asOf = null }) {
    super({ raw, client, projectId, project, user, asOf });
  }

  static async load({ client, documentId, projectId, project = null, user = null }) {
    const raw = await client.documents.get(documentId, true);
    return new UmrDocument({ raw, client, projectId, project, user });
  }

  _snapshot(raw, asOf) {
    return new UmrDocument({
      raw,
      client: this._client,
      projectId: this._projectId,
      project: this._project,
      user: this._user,
      asOf,
    });
  }

  get layerInfo() {
    return this._derived('layerInfo', () => getUmrLayerInfo(this._raw));
  }

  get body() {
    return this.layerInfo.textLayer?.text?.body ?? '';
  }

  // The whole document as graphs: sentences with words, nodes, edges and
  // triples, plus the constants. Cached per data version.
  get graph() {
    return this._derived('graph', () => buildDocumentGraph(this.layerInfo));
  }

  get sentences() {
    return this.graph.sentences;
  }

  // The document in the .umr file format.
  toUmr() {
    return this._derived('umr', () => serializeUmrFile({ sentences: toUmrSentences(this.graph) }));
  }

  // What the official checks find, over the same sentences the export writes.
  get problems() {
    return this._derived('problems', () => validateDocument(toUmrSentences(this.graph)));
  }

  _patchContext(next) {
    return [getUmrLayerInfo(next)];
  }
}
