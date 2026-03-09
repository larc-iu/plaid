const UD = 'ud';

function hasFlag(config, key) {
  return config?.[UD]?.[key] === true;
}

// ── Layer detection ───────────────────────────────────────────────

function detectLayers(doc) {
  const textLayer =
    doc.textLayers.find(l => hasFlag(l.config, 'textLayer')) ??
    doc.textLayers[0] ?? null;

  const tokenLayer = textLayer
    ? (textLayer.tokenLayers.find(l => hasFlag(l.config, 'tokenLayer')) ??
       textLayer.tokenLayers[0] ?? null)
    : null;

  function findSpan(key) {
    if (!tokenLayer) return null;
    return tokenLayer.spanLayers.find(l => hasFlag(l.config, key)) ?? null;
  }

  const lemmaLayer = findSpan('lemma');
  const uposLayer = findSpan('upos');
  const xposLayer = findSpan('xpos');
  const featuresLayer = findSpan('features');
  const sentenceLayer = findSpan('sentence');
  const mwtLayer = findSpan('mwt');

  let relationLayer = null;
  if (lemmaLayer?.relationLayers) {
    relationLayer =
      lemmaLayer.relationLayers.find(l => hasFlag(l.config, 'dependency')) ??
      lemmaLayer.relationLayers[0] ?? null;
  }

  const required = [
    ['textLayer', textLayer],
    ['tokenLayer', tokenLayer],
    ['lemmaLayer', lemmaLayer],
    ['uposLayer', uposLayer],
    ['xposLayer', xposLayer],
    ['featuresLayer', featuresLayer],
    ['sentenceLayer', sentenceLayer],
    ['mwtLayer', mwtLayer],
    ['relationLayer', relationLayer],
  ];
  const missingLayers = required.filter(([, v]) => !v).map(([k]) => k);

  return {
    textLayer, tokenLayer,
    lemmaLayer, uposLayer, xposLayer, featuresLayer,
    sentenceLayer, mwtLayer, relationLayer,
    missingLayers,
    isConfigured: missingLayers.length === 0,
  };
}

// ── Span index: token-id → first matching span ───────────────────

function buildSpanIndex(layer) {
  const idx = new Map();
  if (!layer) return idx;
  for (const span of layer.spans) {
    if (span.tokens) {
      for (const tid of span.tokens) {
        if (!idx.has(tid)) idx.set(tid, span);
      }
    }
  }
  return idx;
}

function buildSpanMultiIndex(layer) {
  const idx = new Map();
  if (!layer) return idx;
  for (const span of layer.spans) {
    if (span.tokens) {
      for (const tid of span.tokens) {
        let arr = idx.get(tid);
        if (!arr) { arr = []; idx.set(tid, arr); }
        arr.push(span);
      }
    }
  }
  return idx;
}

// ── UDDocument ────────────────────────────────────────────────────

export class UDDocument {
  constructor(raw, client) {
    this.raw = raw;
    this._client = client;
    this._layers = null;
    this._sentences = null;
  }

  // ── Writes ─────────────────────────────────────────────────────

  async setLemma(tokenId, value) {
    await this._upsertSpan(this.layerInfo.lemmaLayer, tokenId, value);
  }

  async setUpos(tokenId, value) {
    await this._upsertSpan(this.layerInfo.uposLayer, tokenId, value);
  }

  async setXpos(tokenId, value) {
    await this._upsertSpan(this.layerInfo.xposLayer, tokenId, value);
  }

  async addFeature(tokenId, value) {
    const layer = this.layerInfo.featuresLayer;
    if (!layer) throw new Error('No features layer');
    await this._client.spans.create(layer.id, [tokenId], value);
    this.invalidate();
  }

  async removeFeature(spanId) {
    await this._client.spans.delete(spanId);
    this.invalidate();
  }

  async setRelation(sourceTokenId, targetTokenId, deprel) {
    const info = this.layerInfo;
    if (!info.relationLayer || !info.lemmaLayer) throw new Error('Relation/lemma layer not configured');

    const srcSpanId = await this.ensureLemmaSpan(sourceTokenId);
    const tgtSpanId = await this.ensureLemmaSpan(targetTokenId);

    const existing = info.relationLayer.relations.filter(r => r.target === tgtSpanId);
    for (const rel of existing) {
      await this._client.relations.delete(rel.id);
    }

    await this._client.relations.create(info.relationLayer.id, srcSpanId, tgtSpanId, deprel);
    this.invalidate();
  }

  async setRelationBySpans(sourceSpanId, targetSpanId, deprel) {
    const info = this.layerInfo;
    if (!info.relationLayer) throw new Error('Relation layer not configured');

    const existing = info.relationLayer.relations.filter(r => r.target === targetSpanId);
    for (const rel of existing) {
      await this._client.relations.delete(rel.id);
    }

    await this._client.relations.create(info.relationLayer.id, sourceSpanId, targetSpanId, deprel);
    this.invalidate();
  }

  async updateRelation(relationId, deprel) {
    await this._client.relations.update(relationId, deprel);
    this.invalidate();
  }

  async deleteRelation(relationId) {
    await this._client.relations.delete(relationId);
    this.invalidate();
  }

  async ensureLemmaSpan(tokenId) {
    const info = this.layerInfo;
    const existing = info.lemmaLayer.spans.find(s => s.tokens?.includes(tokenId));
    if (existing) return existing.id;

    const token = info.tokenLayer.tokens.find(t => t.id === tokenId);
    const form = token ? this.textBody.slice(token.begin, token.end) : '_';
    const result = await this._client.spans.create(info.lemmaLayer.id, [tokenId], form);
    return result.id;
  }

  async createToken(textId, begin, end) {
    const info = this.layerInfo;
    if (!info.tokenLayer) throw new Error('No token layer');
    const result = await this._client.tokens.create(info.tokenLayer.id, textId, begin, end);
    this.invalidate();
    return result;
  }

  async deleteToken(tokenId) {
    await this._client.tokens.delete(tokenId);
    this.invalidate();
  }

  async createSentenceSpan(tokenIds, value = '') {
    const info = this.layerInfo;
    if (!info.sentenceLayer) throw new Error('No sentence layer');
    const result = await this._client.spans.create(info.sentenceLayer.id, tokenIds, value);
    this.invalidate();
    return result;
  }

  async deleteSentenceSpan(spanId) {
    await this._client.spans.delete(spanId);
    this.invalidate();
  }

  async createText(body) {
    const info = this.layerInfo;
    if (!info.textLayer) throw new Error('No text layer');
    const result = await this._client.texts.create(info.textLayer.id, this.raw.id, body);
    this.invalidate();
    return result;
  }

  async updateText(body) {
    const info = this.layerInfo;
    if (!info.textLayer?.text) throw new Error('No text');
    await this._client.texts.update(info.textLayer.text.id, body);
    this.invalidate();
  }

  async bulkCreateTokens(tokens) {
    return await this._client.tokens.bulkCreate(tokens);
  }

  async bulkCreateSpans(spans) {
    return await this._client.spans.bulkCreate(spans);
  }

  async reload() {
    const newRaw = await this._client.documents.get(this.raw.id, true);
    this.replaceRaw(newRaw);
    return newRaw;
  }

  async _upsertSpan(layer, tokenId, value) {
    if (!layer) throw new Error('Layer not configured');
    const existing = layer.spans.find(s => s.tokens?.includes(tokenId));
    if (value === '') {
      if (existing) await this._client.spans.delete(existing.id);
    } else if (existing) {
      await this._client.spans.update(existing.id, value);
    } else {
      await this._client.spans.create(layer.id, [tokenId], value);
    }
    this.invalidate();
  }

  // ── Reads ──────────────────────────────────────────────────────

  get layerInfo() {
    if (!this._layers) this._layers = detectLayers(this.raw);
    return this._layers;
  }

  get sentences() {
    if (!this._sentences) this._sentences = this._buildSentences();
    return this._sentences;
  }

  get textBody() {
    return this.layerInfo.textLayer?.text?.body ?? '';
  }

  // ── Invalidation ──────────────────────────────────────────────

  invalidate() {
    this._sentences = null;
  }

  replaceRaw(newRaw) {
    this.raw = newRaw;
    this._layers = null;
    this._sentences = null;
  }

  // ── Private: sentence builder ─────────────────────────────────

  _buildSentences() {
    const info = this.layerInfo;
    const tokenLayer = info.tokenLayer;
    const textBody = this.textBody;
    if (!tokenLayer) return [];

    const sortedTokens = [...tokenLayer.tokens].sort((a, b) => a.begin - b.begin);

    const sentenceStarts = new Set();
    if (info.sentenceLayer) {
      for (const span of info.sentenceLayer.spans) {
        const firstTok = span.tokens?.[0] ?? String(span.begin);
        sentenceStarts.add(String(firstTok));
      }
    }

    const lemmaIdx = buildSpanIndex(info.lemmaLayer);
    const uposIdx = buildSpanIndex(info.uposLayer);
    const xposIdx = buildSpanIndex(info.xposLayer);
    const featsIdx = buildSpanMultiIndex(info.featuresLayer);
    const mwtIdx = buildSpanIndex(info.mwtLayer);

    const relations = info.relationLayer?.relations ?? [];

    const sentences = [];
    let currentTokens = [];
    let sentIdx = 0;

    for (const token of sortedTokens) {
      const tid = String(token.id);

      if (sentenceStarts.has(tid) && currentTokens.length > 0) {
        sentences.push(this._finalizeSentence(sentIdx, currentTokens, relations, info));
        sentIdx++;
        currentTokens = [];
      }

      const tokenForm = textBody.slice(token.begin, token.end);
      currentTokens.push({
        token,
        tokenForm,
        tokenIndex: currentTokens.length + 1,
        lemma: lemmaIdx.get(tid) ?? null,
        upos: uposIdx.get(tid) ?? null,
        xpos: xposIdx.get(tid) ?? null,
        feats: featsIdx.get(tid) ?? [],
        mwt: mwtIdx.get(tid) ?? null,
      });
    }

    if (currentTokens.length > 0) {
      sentences.push(this._finalizeSentence(sentIdx, currentTokens, relations, info));
    }

    return sentences;
  }

  _finalizeSentence(id, tokens, allRelations, info) {
    const lemmaSpans = [];
    const lemmaSpanIds = new Set();
    for (const ta of tokens) {
      if (ta.lemma && !lemmaSpanIds.has(ta.lemma.id)) {
        lemmaSpanIds.add(ta.lemma.id);
        lemmaSpans.push(ta.lemma);
      }
    }

    const mwtSpans = [];
    const mwtIds = new Set();
    for (const ta of tokens) {
      if (ta.mwt && !mwtIds.has(ta.mwt.id)) {
        mwtIds.add(ta.mwt.id);
        mwtSpans.push(ta.mwt);
      }
    }

    const sentRelations = allRelations.filter(
      r => lemmaSpanIds.has(r.source) && lemmaSpanIds.has(r.target)
    );

    return {
      id,
      text: tokens.map(t => t.tokenForm).join(' '),
      tokens,
      relations: sentRelations,
      lemmaSpans,
      mwtSpans,
    };
  }
}
