import { html, nothing } from 'lit-html';
import { readVocabFields } from '@/domain/igtConfig';
import { TAGSET_SOURCE } from '@/domain/glossGuess';
import {
  isGlossLikeField,
  pairRows,
  pickerFieldOf,
  pickerLexicon,
  pickerLexicons,
  senseFills,
} from '@/domain/pairRows';
import { morphemeGlossReading, readingTagset } from '@/domain/tagsets';
import { morphFormOf, numHtml } from './shared.js';

// The pair picker: a morpheme's link and gloss picked together. Alt+Down on a
// morpheme's gloss (alternatives.js) and a click on its lexicon chip
// (vocabPopover.js) list the same rows (domain/pairRows.js), and a pick writes
// both halves in one batch (IgtDocument.setMorphemePair).
export const pairPicker = {
  // Every vocabulary as the picker reads it, once per data version and read
  // of the vocabularies.
  _pickerLexicons() {
    const dv = this.doc?.dataVersion;
    const vocabs = this.doc?.vocabularies;
    if (this._pickerLexKey !== dv || this._pickerLexVocabs !== vocabs || !this._pickerLex) {
      this._pickerLexKey = dv;
      this._pickerLexVocabs = vocabs;
      this._pickerLex = pickerLexicons(
        Object.values(this.doc?.vocabularies || {}).map((v) =>
          pickerLexicon(v, readVocabFields(v.config)),
        ),
      );
    }
    return this._pickerLex;
  },

  _morphFieldNames() {
    return (this.doc.layerInfo?.spanLayers?.morpheme || []).map((l) => l.name);
  },

  // Whether Alt+Down on this morpheme field opens the picker: a gloss field,
  // in a project with a lexicon. Every other field keeps its value list.
  _opensPicker(name) {
    return isGlossLikeField(name) && Object.keys(this.doc.vocabularies || {}).length > 0;
  },

  // A morpheme as the grid derives it, with its word.
  _morphContext(id) {
    for (const s of this.doc.sentences || []) {
      for (const word of s.tokens || []) {
        const morph = (word.morphemes || []).find((x) => x.id === id);
        if (morph) return { morph, word };
      }
    }
    return null;
  },

  // A morpheme field's tagset as the cell reads it (see _morphCol).
  _morphFieldTagset(morph, word, name) {
    const siblings = word?.morphemes || [morph];
    const reading = morphemeGlossReading(
      siblings.map((m) => ({
        morphType: m.morphType,
        form: morphFormOf(m),
        gloss: m.annotations?.[name]?.value ?? '',
      })),
      Math.max(0, siblings.indexOf(morph)),
    );
    return readingTagset(this._tagsetFor('morpheme', name), reading);
  },

  /** The picker's rows for a morpheme and field (pairRows). */
  _pairRows(morph, field, { tagset = null, search = '', cap = Infinity } = {}) {
    return pairRows({
      morph,
      field,
      form: morphFormOf(morph),
      precedent: this._precedentTally(),
      lexicons: this._pickerLexicons(),
      fieldLang: field ? this._entryPairing('morpheme', field, null).fieldLang : null,
      tagset,
      search,
      detailOf: (item, lx) => this._vocabItemDetail(item, this.doc.vocabularies?.[lx.id]),
      cap,
    });
  },

  // The rows a gloss cell lists, once per render pass (see _alternatives).
  _cellPairRows(morph, field, tagset) {
    const key = `pair\u0000${morph.id}\u0000${field}\u0000${JSON.stringify(tagset?.reading ?? null)}`;
    const memo = (this._altsMemo ||= new Map());
    let hit = memo.get(key);
    if (!hit) memo.set(key, (hit = this._pairRows(morph, field, { tagset }).rows));
    return hit;
  },

  /**
   * Write a picked row: the link it names (kept when it names none) and the
   * value, `value` being what the field is set to (the row's, or the stored
   * one for a row with none) and `metadata` the value's stamp. `fill` holds the
   * other fields a pick from the chip sets.
   */
  _writePair(morph, field, row, { value, metadata = null, fill = [] }) {
    const linkStamp =
      row.linkChange && row.linkSource
        ? this.doc.adoptStamp(row.linkSource, { vocabItem: row.itemId })
        : null;
    return this.doc.setMorphemePair(morph.id, {
      field,
      value,
      metadata,
      itemId: row.itemId ?? undefined,
      linkStamp,
      fill,
      adopted: metadata != null || row.model || row.count > 0,
    });
  },

  // A pick from the chip: the row's link and value, and the other gloss fields
  // the sense has a value for, each empty or a machine value nobody confirmed.
  _pickPairFromChip(tokenId, field, row) {
    const ctx = this._morphContext(tokenId);
    if (!ctx) return Promise.resolve(false);
    const { morph, word } = ctx;
    const stored = field ? (morph.annotations?.[field]?.value ?? '') : '';
    const value = row.value !== '' ? row.value : stored;
    const metadata =
      field && stored === '' && value !== '' && row.source && row.source !== TAGSET_SOURCE
        ? this.doc.adoptStamp(row.source, { value })
        : null;
    const others = this._morphFieldNames().filter((f) => f !== field && isGlossLikeField(f));
    const hit = row.itemId ? this._pickerLexicons().byId.get(row.itemId) : null;
    const fill = senseFills({
      morph,
      item: hit?.item ?? null,
      lexicon: hit?.lx ?? null,
      fields: others,
      fieldInfo: (f) => ({
        fieldLang: this._entryPairing('morpheme', f, null).fieldLang,
        tagset: this._morphFieldTagset(morph, word, f),
      }),
    }).map((x) => ({
      ...x,
      metadata:
        (morph.annotations?.[x.field]?.value ?? '') === ''
          ? this.doc.adoptStamp('vocab:entry', { value: x.value })
          : null,
    }));
    if (!field) {
      return row.linkChange ? this.doc.linkVocab(tokenId, row.itemId) : Promise.resolve(true);
    }
    return this._writePair(morph, field, row, { value, metadata, fill });
  },

  /**
   * The chip's rows for a morpheme: the picker field (pickerFieldOf) and its
   * rows for the typed search, capped as the list is.
   */
  _chipPairs(tokenId, search) {
    const ctx = this._morphContext(tokenId);
    const morph = ctx?.morph ?? { id: tokenId, annotations: {}, vocabItem: null };
    const field = pickerFieldOf(morph, this._morphFieldNames());
    const tagset = field && ctx ? this._morphFieldTagset(morph, ctx.word, field) : null;
    const { rows, more } = this._pairRows(morph, field, { tagset, search, cap: 30 });
    return { rows, more, field, morph };
  },

  // A row's cells, the same in both lists: the value, the entry (or "no
  // entry"), the vocabulary when there are several, and the tags.
  _pairRowCells(row, { multiVocab = false, entryLink = null } = {}) {
    const entry = row.item
      ? entryLink
        ? html`<a
            class="igt-pair__entry igt-vocab-pop__form igt-vocab-pop__goto"
            href=${entryLink}
            title="Open this entry in the lexicon"
            @click=${(e) => e.stopPropagation()}
            >${row.item.form}${numHtml(row.sub, 'igt-vocab-pop')}</a
          >`
        : html`<span class="igt-pair__entry igt-vocab-pop__form"
            >${row.item.form}${numHtml(row.sub, 'igt-vocab-pop')}</span
          >`
      : html`<span class="igt-pair__entry igt-pair__none">no entry</span>`;
    const tags = [];
    if (row.current) tags.push('current');
    // Rounded down, as every confidence is (plaid-ui domain/confidence.js).
    if (row.model) {
      tags.push(row.prob != null ? `model ${Math.floor(row.prob * 100 + 1e-9)}%` : 'model');
    }
    if (row.count) tags.push(`×${row.count}`);
    if (row.current && row.item && this.doc.reviewableState(row.linkState)) {
      tags.push('unconfirmed');
    }
    return html`<span class="igt-pair__value" dir="auto">${row.value}</span>
      ${entry}
      ${multiVocab && row.vocabName
        ? html`<span class="igt-pair__vocab">${row.vocabName}</span>`
        : nothing}
      ${row.description ? html`<span class="igt-pair__desc">${row.description}</span>` : nothing}
      <span class="igt-pair__tags">${tags.join(' · ')}</span>`;
  },

  // Whether picking the current row confirms something: a link or a value
  // this writer reviews.
  _pairConfirms(row) {
    return (
      !!row.current &&
      ((!!row.item && this.doc.reviewableState(row.linkState)) ||
        (row.value !== '' && this.doc.reviewable(row.valueMeta)))
    );
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
