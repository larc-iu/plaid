import { html, nothing } from 'lit-html';
import { TAGSET_SOURCE, VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';
import {
  pairRows,
  pickerFieldOf,
  pickerLexicon,
  pickerLexicons,
  senseFills,
} from '@/domain/pairRows';
import { morphemeGlossReading, readingTagset } from '@/domain/tagsets';
import { morphFormOf, numHtml } from './shared.js';

// The pair picker: a morpheme's link and value picked together. Alt+Down on a
// morpheme field with a Lexicon field (alternatives.js; domain/lexiconField.js)
// and a click on its lexicon chip
// (vocabPopover.js) list the same rows (domain/pairRows.js), drawn by one
// template, and a pick from either goes through one path (_pickPairRow) to one
// batch (IgtDocument.setMorphemePair).
export const pairPicker = {
  // Every vocabulary as the picker reads it. Asked once per paired cell per
  // render, so it answers at once while the data has not changed. After a
  // change a vocabulary is read again only when its entry list or its
  // name changed: an edit keeps the entry list it did not touch
  // (IgtDocument's keepUnchangedLists), and the sense tree of a large lexicon
  // is not worth building on every keystroke.
  _pickerLexicons() {
    const dv = this.doc?.dataVersion;
    const vocabsNow = this.doc?.vocabularies;
    if (this._pickerLex && this._pickerLexDv === dv && this._pickerLexVocabs === vocabsNow) {
      return this._pickerLex;
    }
    this._pickerLexDv = dv;
    this._pickerLexVocabs = vocabsNow;
    const memo = (this._pickerLexMemo ||= new Map());
    const list = Object.values(vocabsNow || {}).map((v) => {
      const hit = memo.get(v.id);
      if (hit && hit.items === v.items && hit.name === v.name) return hit.lx;
      const lx = pickerLexicon(v);
      memo.set(v.id, { items: v.items, name: v.name, lx });
      return lx;
    });
    const prev = this._pickerLex;
    if (!prev || prev.length !== list.length || list.some((lx, i) => lx !== prev[i])) {
      this._pickerLex = pickerLexicons(list);
    }
    return this._pickerLex;
  },

  // The morpheme fields with a Lexicon field, in grid order.
  _pairedMorphFields() {
    return (this.doc.layerInfo?.spanLayers?.morpheme || [])
      .map((l) => l.name)
      .filter((name) => this._lexiconFieldOf('morpheme', name));
  },

  // Whether Alt+Down on this morpheme field opens the picker: a field with a
  // Lexicon field, in a project with a lexicon. Every other field keeps its
  // value list.
  _opensPicker(name) {
    return (
      !!this._lexiconFieldOf('morpheme', name) &&
      Object.keys(this.doc.vocabularies || {}).length > 0
    );
  },

  // A morpheme as the grid derives it, with its word and its sentence's place.
  _morphContext(id) {
    const sentences = this.doc.sentences || [];
    for (let index = 0; index < sentences.length; index++) {
      for (const word of sentences[index].tokens || []) {
        const morph = (word.morphemes || []).find((x) => x.id === id);
        if (morph) return { morph, word, index };
      }
    }
    return null;
  },

  // How a morpheme field's cell reads its value (an affix's gloss against
  // the tagset alone, a stem's with the word's other stems'), and the tagset
  // as read so.
  _morphFieldReading(morph, word, name) {
    const siblings = word?.morphemes || [morph];
    const reading = morphemeGlossReading(
      siblings.map((m) => ({
        morphType: m.morphType,
        form: morphFormOf(m),
        gloss: m.annotations?.[name]?.value ?? '',
      })),
      Math.max(0, siblings.indexOf(morph)),
    );
    return { reading, tagset: readingTagset(this._tagsetFor('morpheme', name), reading) };
  },

  _morphFieldTagset(morph, word, name) {
    return this._morphFieldReading(morph, word, name).tagset;
  },

  /** The picker's rows for a morpheme and field (pairRows). */
  _pairRows(morph, field, { tagset = null, search = '', cap = Infinity, chip = false } = {}) {
    return pairRows({
      morph,
      field,
      form: morphFormOf(morph),
      precedent: this._precedentTally(),
      lexicons: this._pickerLexicons(),
      lexiconField: field ? this._lexiconFieldOf('morpheme', field) : null,
      tagset,
      search,
      detailOf: (item, lx) => this._vocabItemDetail(item, this.doc.vocabularies?.[lx.id]),
      cap,
      keepPersonValue: chip,
    });
  },

  // The rows a paired cell lists, once per render pass (see _alternatives).
  _cellPairRows(morph, field, tagset) {
    const key = `pair\u0000${morph.id}\u0000${field}\u0000${JSON.stringify(tagset?.reading ?? null)}`;
    const memo = (this._altsMemo ||= new Map());
    let hit = memo.get(key);
    if (!hit) memo.set(key, (hit = this._pairRows(morph, field, { tagset }).rows));
    return hit;
  },

  /**
   * The chip's rows for a morpheme: the picker field (pickerFieldOf) and its
   * rows for the typed search, capped as the list is. Over a value a person
   * wrote, a sense keeps it (pairRows' keepPersonValue).
   */
  _chipPairs(tokenId, search) {
    const ctx = this._morphContext(tokenId);
    const morph = ctx?.morph ?? { id: tokenId, annotations: {}, vocabItem: null };
    const field = pickerFieldOf(morph, this._pairedMorphFields(), (name) =>
      this._lexiconFieldOf('morpheme', name),
    );
    const tagset = field && ctx ? this._morphFieldTagset(morph, ctx.word, field) : null;
    const { rows, more } = this._pairRows(morph, field, { tagset, search, cap: 30, chip: true });
    return { rows, more, field, morph };
  },

  // The row a list starts on: the current link, else the first sense that
  // keeps the value there is, else the first sense, else the first row.
  _pairDefaultRow(rows) {
    const current = rows.findIndex((r) => r.current && r.item);
    if (current >= 0) return current;
    const value = rows.find((r) => r.current)?.value ?? '';
    const sense = (r) => r.named && r.itemId && !r.context && !r.current;
    const keeps = value ? rows.findIndex((r) => sense(r) && r.value === value) : -1;
    if (keeps >= 0) return keeps;
    return Math.max(0, rows.findIndex(sense));
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

  // Whether picking a row with the cell holding `value` writes anything.
  _pairActs(row, value) {
    return (row.value !== '' && row.value !== value) || row.linkChange || this._pairConfirms(row);
  },

  /**
   * Write a picked row, from either door: the entry it names (a row that
   * names none leaves the link as it is) and its value (a row with none
   * leaves the value, or writes `typed`, what the cell holds). The value is
   * stamped as adopting the row's suggestion when the field was empty, and
   * the link as adopting the producer's when the row is the producer's,
   * unless the row was found by a typed search (`searched`). From the chip
   * (`fill`) the sense also fills the other paired fields that are empty or
   * hold a machine value nobody confirmed. One History label for both doors.
   */
  _pickPairRow(morphId, field, row, { typed = null, searched = false, fill = false } = {}) {
    const ctx = this._morphContext(morphId);
    if (!ctx) return Promise.resolve(false);
    const { morph, word, index } = ctx;
    const stored = field ? (morph.annotations?.[field]?.value ?? '') : '';
    const value = row.value !== '' ? row.value : (typed ?? stored);
    const suggested = !searched && row.value !== '' && row.source && row.source !== TAGSET_SOURCE;
    const metadata =
      field && stored === '' && value !== '' && suggested
        ? this.doc.adoptStamp(row.source, { value })
        : null;
    const named = row.named && row.itemId ? row.itemId : undefined;
    const linkStamp =
      named && row.linkChange && row.linkSource && !searched
        ? this.doc.adoptStamp(row.linkSource, { vocabItem: row.itemId })
        : null;
    const fills = fill ? this._senseFillsFor(morph, word, field, row) : [];
    const label =
      field && value !== stored
        ? this._editLabel(
            field,
            this._morphemeSubject(morph, word, word.morphemes || []),
            index,
            value,
          )
        : null;
    return this.doc.labelled(label, () =>
      this.doc.setMorphemePair(morph.id, {
        field,
        value,
        metadata,
        itemId: named,
        linkStamp,
        fill: fills,
        // A row that showed no value of its own, or kept a person's, does not
        // vouch for the value there.
        confirmValue: row.value !== '' && !row.senseValue,
        adopted: metadata != null || (!searched && (row.model || row.count > 0)),
      }),
    );
  },

  // The other paired fields a sense fills, each with its stamp.
  _senseFillsFor(morph, word, field, row) {
    const hit = row.named && row.itemId ? this._pickerLexicons().byId.get(row.itemId) : null;
    if (!hit) return [];
    return senseFills({
      morph,
      item: hit.item,
      fields: this._pairedMorphFields().filter((f) => f !== field),
      fieldInfo: (f) => ({
        lexiconField: this._lexiconFieldOf('morpheme', f),
        tagset: this._morphFieldTagset(morph, word, f),
      }),
    }).map((x) => ({
      ...x,
      metadata:
        (morph.annotations?.[x.field]?.value ?? '') === ''
          ? this.doc.adoptStamp(VOCAB_ENTRY_SOURCE, { value: x.value })
          : null,
    }));
  },

  // A row's cells, the same in both lists: the value, the entry (empty for a
  // row that names none, "no entry" on an unlinked morpheme's current row),
  // the sense's own value when the row keeps another, the vocabulary when
  // there are several, the tags, and the entry's detail line.
  // `extra`: the chip's actions on the row, at the end of its line.
  _pairRowCells(row, { multiVocab = false, entryLink = null, extra = nothing } = {}) {
    const form = row.item ? html`${row.item.form}${numHtml(row.sub, 'igt-vocab-pop')}` : null;
    const entry =
      row.named && row.item
        ? entryLink
          ? html`<a
              class="igt-pair__entry igt-vocab-pop__form igt-vocab-pop__goto"
              href=${entryLink}
              title="Open this entry in the lexicon"
              @click=${(e) => e.stopPropagation()}
              >${form}</a
            >`
          : html`<span class="igt-pair__entry igt-vocab-pop__form">${form}</span>`
        : row.current && !row.item
          ? html`<span class="igt-pair__entry igt-pair__none">no entry</span>`
          : html`<span class="igt-pair__entry"></span>`;
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
    // A row that names no entry shows nothing of the one it carries.
    const vocab =
      row.named && row.item && row.vocabId ? this.doc.vocabularies?.[row.vocabId] : null;
    const detail = vocab ? this._vocabItemDetail(row.item, vocab) : '';
    return html`<span class="igt-pair__line">
        <span class="igt-pair__value" dir="auto">${row.value}</span>
        ${entry}
        ${row.senseValue
          ? html`<span class="igt-pair__sense" dir="auto">${row.senseValue}</span>`
          : nothing}
        ${multiVocab && vocab && row.vocabName
          ? html`<span class="igt-pair__vocab">${row.vocabName}</span>`
          : nothing}
        ${row.description ? html`<span class="igt-pair__desc">${row.description}</span>` : nothing}
        <span class="igt-pair__tags">${tags.join(' · ')}</span>
        ${this._pairConfirms(row) ? html`<span class="igt-vocab-pop__ok">accept</span>` : nothing}
        ${extra}
      </span>
      ${detail && detail !== row.value && detail !== row.senseValue
        ? html`<span class="igt-vocab-pop__detail">${detail}</span>`
        : nothing}`;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
