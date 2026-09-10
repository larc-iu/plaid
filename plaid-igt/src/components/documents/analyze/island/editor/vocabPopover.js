import { html, nothing } from 'lit-html';
import { live } from 'lit-html/directives/live.js';
import { readVocabFields, trimIgnoredEdges } from '@/domain/igtConfig';
import { morphTypeLabel, morphTypeOptions } from '@/domain/affixMarkers';
import { groupRankedByHeadword, itemLabel, lexiconView, refIds } from '@/domain/vocabDictionary';
import { FIELD_TYPES, RESERVED_ITEM_KEYS } from '@/domain/vocabFields';
import { rankVocabItems, TIERS } from '@/domain/vocabRank';
import { isMweType } from '@/domain/mwe';
import {
  SLOT_LINK,
  linkPrecedentQueries,
  valuePrecedentQueries,
  createTally,
  foldProject,
  foldDocument,
  precedentCounts,
  precedentForm,
} from '@/domain/precedent';
import { sameFormUnlinked } from '@/domain/linkEverywhere.js';
import { NO_PRECEDENT, numHtml } from './shared.js';

// The vocab popover: the ranked entries for a form, the precedent tally that
// ranks them, the entry detail, and the morph type row.
export const vocabPopover = {
  // Everything the popover derives from one vocabulary, built once per
  // doc.dataVersion: the sense tree, the dotted numbers, the id index, the
  // morph type each entry goes by, and which fields are shown inline. The
  // popover re-renders on every keystroke in its search box and reads these
  // once per row of a list that can hold the whole lexicon.
  _vocabMemoFor(vocabId) {
    const dv = this.doc?.dataVersion;
    if (this._vocabMemoKey !== dv) {
      this._vocabMemoKey = dv;
      this._vocabMemo = new Map();
    }
    if (!this._vocabMemo.has(vocabId)) {
      const vocab = (this.doc?.vocabularies || {})[vocabId];
      const fields = readVocabFields(vocab?.config) || {};
      const inlineNames = Object.keys(fields).filter((n) => fields[n]?.inline);
      this._vocabMemo.set(vocabId, {
        ...lexiconView(vocab?.items || []),
        fields,
        inlineNames,
        hasRefs: inlineNames.some((n) => fields[n]?.type === FIELD_TYPES.ITEM),
      });
    }
    return this._vocabMemo.get(vocabId);
  },

  // The dotted number an entry goes by (buildItemNumbers), which tells apart
  // both the senses under an entry and the entries spelled alike.
  _itemNumbersFor(vocabId) {
    return this._vocabMemoFor(vocabId).numbers;
  },

  // The sense tree the popover groups its candidates by.
  _senseTreeFor(vocabId) {
    return this._vocabMemoFor(vocabId).tree;
  },

  // Precedent (domain/precedent.js) behind the popover's ranking and the
  // gloss guesses: the project-wide link and annotation-value tallies,
  // fetched once per document with THIS document left out, plus this
  // document's own links and values folded live from the derived sentences,
  // so a decision made a moment ago already counts and nothing is counted
  // twice. Until the queries answer, everything ranks on the document alone;
  // the island re-renders when they land. A failed fetch keeps it that way
  // (popover and guesses still work).
  //
  // `force` bypasses the same-key cache: someone else's decision elsewhere in
  // the project between fetches would otherwise never be seen for the life of
  // this instance (see the visibilitychange listener in the constructor).
  _ensurePrecedent(force = false) {
    const doc = this.doc;
    const vocabIds = Object.keys(doc?.vocabularies || {}).sort();
    const valueQueries = doc?.layerInfo
      ? valuePrecedentQueries(doc.layerInfo, { excludeDocId: doc.id })
      : [];
    const key = `${doc?.id}|${vocabIds.join(',')}|${valueQueries
      .map((q) => q.query.where[0][2].layer)
      .join(',')}`;
    if (!force && this._precedent?.key === key) return;
    const state = { key, results: null };
    this._precedent = state;
    this._precedentFetchedAt = Date.now();
    if (!doc?.client || (!vocabIds.length && !valueQueries.length)) return;
    const client = doc.client;
    Promise.all([
      Promise.all(
        linkPrecedentQueries(vocabIds, { excludeDocId: doc.id }).map((q) => client.query(q)),
      ),
      Promise.all(
        valueQueries.map(({ kind, field, query }) =>
          client.query(query).then((results) => ({ kind, field, results })),
        ),
      ),
    ])
      .then(([links, values]) => {
        state.results = { links, values };
      })
      .catch((err) => {
        console.warn('Project precedent unavailable; using this document only:', err);
        state.results = NO_PRECEDENT;
      })
      .finally(() => {
        if (this._precedent === state) this._render(true);
      });
  },

  _precedentTally() {
    const results = this._precedent?.results || NO_PRECEDENT;
    const dv = this.doc?.dataVersion;
    const memo = this._precedentMemo;
    if (!memo || memo.results !== results || memo.dv !== dv) {
      const info = this.doc?.layerInfo;
      const tally = foldProject(createTally(), results, this._ignoredCfg);
      foldDocument(tally, this.doc?.sentences, {
        wordFields: (info?.spanLayers?.word || []).map((l) => l.name),
        morphFields: (info?.spanLayers?.morpheme || []).map((l) => l.name),
        ignoredCfg: this._ignoredCfg,
      });
      this._precedentMemo = { results, dv, tally };
    }
    return this._precedentMemo.tally;
  },

  // The tally key for a word/morpheme: a word loses edge punctuation by the
  // ignore rule (as the auto-linker and "+ Create" do), a morpheme form is
  // taken verbatim.
  _precedentForm(formText, kind) {
    return precedentForm(formText, kind, this._ignoredCfg);
  },

  _itemNumber(vocabItem) {
    if (!vocabItem?.vocabId) return null;
    return this._itemNumbersFor(vocabItem.vocabId).get(vocabItem.id) ?? null;
  },

  // The secondary line for a popover item row: values of the vocab's
  // inline-flagged custom fields (vocab config igt.fields {name: {inline}}),
  // falling back to the item's first non-empty metadata value when no field
  // is flagged — so glosses/definitions show out of the box and homophonous
  // forms are distinguishable.
  _vocabItemDetail(item, vocab) {
    const meta = item.metadata || {};
    const memo = this._vocabMemoFor(vocab?.id);
    const { fields, inlineNames, hasRefs } = memo;
    // The fallback reads whatever the entry carries, so it has to skip the
    // reserved keys: `parent` is an id, and it is written first, so a
    // vocabulary with no inline field would show a UUID here.
    const names = inlineNames.length
      ? inlineNames
      : Object.keys(meta).filter((n) => !RESERVED_ITEM_KEYS.has(n));
    // A field of type `item` holds entry ids. It reads as the entries they
    // name, numbered as everything else in the popover is.
    const refLabel = (id) => itemLabel(memo.byId.get(id), memo.numbers);
    const valueOf = (n) => {
      if (n === 'morphType') return morphTypeLabel(meta[n]);
      if (!hasRefs || fields[n]?.type !== FIELD_TYPES.ITEM) return meta[n];
      return refIds(item, { name: n }).map(refLabel).filter(Boolean).join(', ');
    };
    const vals = names
      .map(valueOf)
      .filter((v) => v != null && String(v).trim() !== '')
      .map(String);
    return inlineNames.length ? vals.join(' · ') : (vals[0] ?? '');
  },

  _vocabPopover(tokenId, formText, currentItem, kind) {
    const vocabs = Object.values(this.doc.vocabularies || {});
    // The popover is scoped to ONE vocabulary at a time, chosen by the thin
    // selector at the bottom. Default to the linked item's vocab (so an existing
    // link is visible), else the first. The list, create, and manage row all
    // follow the active vocab.
    const activeVocab =
      vocabs.find((v) => v.id === this._popoverVocabId) ||
      vocabs.find((v) => v.id === currentItem?.vocabId) ||
      vocabs[0] ||
      null;
    this._popoverVocabId = activeVocab?.id ?? null;

    const search = this._popoverSearch || '';
    const numIdx = activeVocab ? this._itemNumbersFor(activeVocab.id) : null;
    // Ranked by vocabRank.js: what this form was linked to before comes
    // first, then form-match tiers; a typed search ranks against the typed
    // text alone.
    const isMwe = kind === 'mwe';
    const precForm = isMwe ? formText : this._precedentForm(formText, kind);
    const items = rankVocabItems(
      (activeVocab?.items || []).map((it) => ({
        ...it,
        _detail: this._vocabItemDetail(it, activeVocab),
        _sub: numIdx ? numIdx.get(it.id) : null,
      })),
      {
        form: formText || '',
        search,
        // Precedent is tallied per word or morpheme form; the joined form of
        // a multi-word expression has none.
        precedent: isMwe
          ? null
          : precedentCounts(this._precedentTally(), kind, precForm, SLOT_LINK),
      },
    );
    // In MWE mode the phrase-typed entries come first, in their ranked order.
    // Single-word entries stay listed: a fixed spelling can be what is wanted.
    if (isMwe) {
      const typeOf = activeVocab
        ? (it) => this._vocabMemoFor(activeVocab.id).morphTypeOf(it.id)
        : (it) => it.metadata?.morphType;
      const phrases = items.filter((it) => isMweType(typeOf(it)));
      const others = items.filter((it) => !isMweType(typeOf(it)));
      items.splice(0, items.length, ...phrases, ...others);
    }
    if (currentItem) {
      const i = items.findIndex((it) => it.id === currentItem.id);
      if (i > 0) {
        const [x] = items.splice(i, 1);
        items.unshift(x);
      }
    }
    // The candidates read like the dictionary: each headword once, its senses
    // under it, numbered; a headword that only carries senses is shown for
    // context, dimmed. Each row keeps its rank.
    const grouped = activeVocab
      ? groupRankedByHeadword(items, activeVocab.items || [], this._senseTreeFor(activeVocab.id))
      : items.map((it) => ({ item: it, depth: 0 }));
    const limited = grouped.slice(0, 30).map((r) => ({
      ...r.item,
      // A row shown only for context never went through the ranking, so it
      // arrives undecorated: give it the same number and detail line, or a
      // headword reads like a lone entry.
      _sub: r.item._sub ?? (numIdx ? numIdx.get(r.item.id) : null),
      _detail: r.item._detail ?? this._vocabItemDetail(r.item, activeVocab),
      _depth: r.depth,
      _context: !!r.context,
    }));
    // What the cap left out, counted in candidates: a headword drawn only
    // as context above its senses was never one.
    const truncated = items.length - limited.filter((r) => !r._context).length;
    // The form a new entry would get: the word/morpheme's surface with edge
    // punctuation trimmed by the project's own ignored-tokens rule
    // (`derechos.` → `derechos`; user decision 2026-08-26).
    const createForm = trimIgnoredEdges(formText || '', this._ignoredCfg);
    // A single "+ Create" row, into the active vocab, when there's a form AND
    // this user may add entries to it. Item creation needs vocab-maintainer
    // rights while linking needs only project-writer + vocab-reader, so a
    // writer who can link may still not create — hide the row instead of
    // letting it 403.
    const canCreate = !!(createForm && activeVocab && this.canWriteVocab(activeVocab));
    // While the row is being edited the entry's form is whatever is typed.
    const editingCreate = canCreate && this._popoverCreateEdit != null;
    const effectiveForm = editingCreate ? this._popoverCreateEdit.trim() : createForm;
    // If the form already exists in the active vocab, the new entry would be
    // spelled like an existing one. Preview the number it would get (existing
    // count + 1) and say so, since a duplicate is usually a mis-click on the
    // existing entry. Only ENTRIES count, since a new one is an entry.
    const newFormDupes =
      canCreate && effectiveForm
        ? (activeVocab.items || []).filter(
            (it) => it.form === effectiveForm && !it.metadata?.parent,
          ).length
        : 0;
    const newFormSub = newFormDupes >= 1 ? String(newFormDupes + 1) : null;
    // Rows on a WORD's popover for its multi-word expressions: one per MWE it
    // belongs to (opens that one), then "Part of a longer expression…", which
    // starts gathering words around it.
    const extraRows = [];
    if (kind === 'word' && this._canLinkMwe()) {
      const word = this.doc.tokenLookup.get(tokenId);
      const sentence = word && this.doc.findSentenceForToken(word);
      for (const m of sentence?.mwes || []) {
        if (!m.memberTokenIds.includes(tokenId)) continue;
        extraRows.push({
          kind: 'in',
          label: m.item.form,
          sub: this._itemNumber(this._mweItem(m)),
          title: `Open the multi-word expression “${this._mweWords(m.memberTokenIds)}”`,
          onSelect: () => this._openMweByLink(m.linkId),
        });
      }
      if (sentence) {
        extraRows.push({
          kind: 'start',
          label: 'Part of a multi-word expression…',
          title: 'Gather this word with others into one multi-word expression',
          onSelect: () => this._startMweSelection(sentence.id, tokenId),
        });
      }
    }
    // Rows the keyboard can land on: every item, the create row, the extras.
    const total = limited.length + (canCreate ? 1 : 0) + extraRows.length;
    // Where the keyboard lands before it is moved: the best-ranked candidate
    // that is not a headword standing over one of its own same-form senses
    // in the list. Such a headword ranks level with its senses (same form,
    // same tier) and, created first by an import, would win the tie on id;
    // the auto-linker drops it for the same reason (dropCoveredHeadwords).
    // A headword the form was linked to before keeps its place: precedent is
    // a person's own choice. Every row stays selectable by arrow or click:
    // linking to a headword is the user's call, just never the one Enter
    // makes on its own.
    const rankedIds = new Set(items.map((it) => it.id));
    const tree = activeVocab ? this._senseTreeFor(activeVocab.id) : null;
    const covered = (it) =>
      it._tier !== TIERS.PRECEDENT &&
      (tree?.childrenOf.get(it.id) || []).some((c) => c.form === it.form && rankedIds.has(c.id));
    const first = items.find((it) => !covered(it)) ?? items[0];
    const best = limited.findIndex((r) => !r._context && r.id === first?.id);
    if (this._popoverActiveIndex == null) this._popoverActiveIndex = Math.max(0, best);
    const activeIdx = Math.min(this._popoverActiveIndex ?? 0, Math.max(0, total - 1));
    // The three actions, routed by mode: a word's or morpheme's own link, or
    // the multi-word expression's.
    const act = {
      confirm: (rf) =>
        isMwe ? this._confirmMwe(currentItem.linkId, rf) : this._confirmLink(tokenId, rf),
      toggle: (it, linked, rf) =>
        isMwe ? this._toggleMwe(it, linked, rf) : this._toggleVocab(tokenId, it, linked, rf),
      create: (form, rf) =>
        isMwe
          ? this._createMwe(activeVocab.id, form, rf)
          : this._createVocab(tokenId, activeVocab.id, form, rf),
    };
    const pos = this._popoverPos;
    const posStyle = pos
      ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;`
      : '';

    // For a link this writer reviews, selecting the linked row CONFIRMS it (the
    // gesture that merges the writer's confirm stamp); for any other link it
    // unlinks (toggle), as before. The explicit "unlink" mini-action is always
    // available.
    const inferredCurrent = this.doc.reviewableState(currentItem?.prov);
    const selectActive = (immediate = false) => {
      if (activeIdx < limited.length) {
        const it = limited[activeIdx];
        const linked = currentItem && it.id === currentItem.id;
        if (linked && inferredCurrent) act.confirm(true);
        else act.toggle(it, linked, true);
      } else if (canCreate && activeIdx === limited.length) {
        // Enter on the create row opens the inline editor (edit the form
        // first); Ctrl/Cmd+Enter creates as-is, like a double-click.
        if (immediate) act.create(createForm, true);
        else this._openCreateEdit(createForm);
      } else {
        extraRows[activeIdx - limited.length - (canCreate ? 1 : 0)]?.onSelect();
      }
    };
    // Inline create editor keys: Enter creates (non-empty), Escape goes back
    // to the search box, Tab stays trapped in the dialog.
    const onCreateEditKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = (e.target.value || '').trim();
        if (v) act.create(v, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._cancelCreateEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
      }
    };
    // Click on the create row: a single click opens the editor, a double
    // click (second click within 250ms) creates immediately. While editing,
    // a click on the row acts as the "create" button for the typed form.
    const onCreateClick = (e) => {
      e.stopPropagation();
      if (editingCreate) {
        const v = effectiveForm;
        if (v) act.create(v);
        return;
      }
      if (this._createClickTimer) {
        clearTimeout(this._createClickTimer);
        this._createClickTimer = null;
        act.create(createForm);
        return;
      }
      this._createClickTimer = setTimeout(() => {
        this._createClickTimer = null;
        if (this._popover) this._openCreateEdit(createForm);
      }, 250);
    };
    const onSearchKey = (e) => {
      // Popover keys must not bubble to the container's review-sweep handler:
      // Enter here selects a row, which moves focus onto a chip, and the same
      // keydown would then be read as "Enter on a focused chip" (a stray
      // confirm + focus hop to the next suggestion).
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closePopover(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._movePopoverActive(1, total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._movePopoverActive(-1, total);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectActive(e.ctrlKey || e.metaKey);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } // trap focus in the search box
    };
    const selectVocab = (id) => {
      this._popoverVocabId = id;
      this._popoverActiveIndex = null; // another lexicon, another best row
      this._render(true);
    };

    return html`
      <div
        class="igt-vocab-pop"
        data-igt-pop
        style=${posStyle}
        role="dialog"
        aria-label=${isMwe ? 'Link words to lexicon' : 'Link to lexicon'}
        @click=${(e) => e.stopPropagation()}
      >
        ${isMwe ? this._mweMembersStrip() : nothing}
        <input
          class="igt-vocab-pop__search"
          spellcheck="false"
          data-pop-autofocus
          placeholder="Search lexicon…"
          aria-label="Search lexicon"
          .value=${live(this._popoverSearch || '')}
          @input=${(e) => {
            this._popoverSearch = e.target.value;
            this._popoverActiveIndex = null; // re-pick the best-ranked row
            this._render(true);
          }}
          @keydown=${onSearchKey}
        />
        <div class="igt-vocab-pop__list">
          ${limited.length
            ? limited.map((it, i) => {
                const linked = currentItem && it.id === currentItem.id;
                const confirmable = linked && inferredCurrent;
                return html`<button
                  type="button"
                  class="igt-vocab-pop__item ${linked ? 'is-linked' : ''} ${i === activeIdx
                    ? 'is-active'
                    : ''} ${it._context ? 'is-context' : ''}"
                  style=${it._depth ? `margin-left:${it._depth * 14}px` : ''}
                  @mousemove=${(e) => {
                    if (!this._pointerMoved(e)) return;
                    if (this._popoverActiveIndex !== i) {
                      this._popoverActiveIndex = i;
                      this._render(true);
                    }
                  }}
                  @click=${(e) => {
                    e.stopPropagation();
                    if (confirmable) act.confirm();
                    else act.toggle(it, linked);
                  }}
                >
                  <span class="igt-vocab-pop__main">
                    ${linked
                      ? html`<a
                          class="igt-vocab-pop__form igt-vocab-pop__goto"
                          href=${`#/vocabularies/${activeVocab.id}?item=${it.id}`}
                          title="Open this entry in the lexicon"
                          @click=${(e) => e.stopPropagation()}
                          >${it.form}${numHtml(it._sub, 'igt-vocab-pop')}</a
                        >`
                      : html`<span class="igt-vocab-pop__form"
                          >${it.form}${numHtml(it._sub, 'igt-vocab-pop')}</span
                        >`}
                    ${it._prec
                      ? html`<span
                          class="igt-vocab-pop__prec"
                          title=${`“${precForm}” was linked to this entry ${it._prec} time${
                            it._prec === 1 ? '' : 's'
                          } in this project`}
                          >×${it._prec}</span
                        >`
                      : nothing}
                    ${confirmable ? html`<span class="igt-vocab-pop__ok">confirm</span>` : nothing}
                    ${linked
                      ? html`<span
                          class="igt-vocab-pop__x"
                          role="button"
                          tabindex="-1"
                          @click=${(e) => {
                            e.stopPropagation();
                            act.toggle(it, true);
                          }}
                          >unlink</span
                        >`
                      : nothing}
                  </span>
                  ${it._detail
                    ? html`<span class="igt-vocab-pop__detail">${it._detail}</span>`
                    : nothing}
                </button>`;
              })
            : html`<div class="igt-vocab-pop__empty">No matches</div>`}
          ${truncated > 0
            ? html`<div class="igt-vocab-pop__more">+ ${truncated} more. Type to narrow</div>`
            : nothing}
        </div>
        ${canCreate
          ? html`<button
              type="button"
              class="igt-vocab-pop__create ${activeIdx === limited.length ? 'is-active' : ''}"
              @mousemove=${(e) => {
                if (!this._pointerMoved(e)) return;
                const idx = limited.length;
                if (this._popoverActiveIndex !== idx) {
                  this._popoverActiveIndex = idx;
                  this._render(true);
                }
              }}
              title=${editingCreate
                ? 'Enter creates the entry as typed · Esc cancels'
                : 'Click to edit the form before creating · double-click creates as is'}
              @click=${onCreateClick}
            >
              ${editingCreate
                ? html`+ Create
                    <input
                      class="igt-vocab-pop__create-input"
                      spellcheck="false"
                      aria-label="New entry form"
                      .value=${live(this._popoverCreateEdit)}
                      @click=${(e) => e.stopPropagation()}
                      @input=${(e) => {
                        this._popoverCreateEdit = e.target.value;
                        this._render(true);
                      }}
                      @keydown=${onCreateEditKey}
                    />${numHtml(newFormSub, 'igt-vocab-pop')}`
                : html`+ Create "${createForm}${numHtml(newFormSub, 'igt-vocab-pop')}"`}
              ${newFormSub != null
                ? html`<span class="igt-vocab-pop__note"
                    >“${effectiveForm}” already exists. This adds a separate entry</span
                  >`
                : nothing}
            </button>`
          : nothing}
        ${extraRows.map((r, j) => {
          const idx = limited.length + (canCreate ? 1 : 0) + j;
          return html`<button
            type="button"
            class="igt-vocab-pop__mwe ${idx === activeIdx ? 'is-active' : ''}"
            title=${r.title}
            @mousemove=${(e) => {
              if (!this._pointerMoved(e)) return;
              if (this._popoverActiveIndex !== idx) {
                this._popoverActiveIndex = idx;
                this._render(true);
              }
            }}
            @click=${(e) => {
              e.stopPropagation();
              r.onSelect();
            }}
          >
            <svg viewBox="0 0 16 12" aria-hidden="true">
              <path d="M1.5 3v6h13V3" stroke-width="1.2" stroke-linecap="round"></path>
            </svg>
            ${r.kind === 'in'
              ? html`<span class="igt-vocab-pop__mwe-in">In:</span> ${r.label}${numHtml(
                    r.sub,
                    'igt-vocab-pop',
                  )}`
              : r.label}
          </button>`;
        })}
        ${(() => {
          // Offered once the token is linked and there is anything to link.
          if (!currentItem || isMwe) return nothing;
          const others = sameFormUnlinked(this.doc.sentences, kind, formText, tokenId);
          if (!others.length) return nothing;
          return html`<button
            type="button"
            class="igt-vocab-pop__all"
            title=${`Link the ${others.length} other unlinked “${formText}” in this text to ${currentItem.form}`}
            @click=${(e) => {
              e.stopPropagation();
              this._linkEverywhere(tokenId, kind, formText, currentItem, true);
            }}
          >
            Link every “${formText}” in this text
            <span class="igt-vocab-pop__prec">×${others.length}</span>
          </button>`;
        })()}
        ${kind === 'morpheme'
          ? this._morphTypeRow(tokenId, currentItem)
          : isMwe
            ? this._mweTypeRow(currentItem)
            : nothing}
        ${vocabs.length
          ? html`<div class="igt-vocab-pop__vocabsel" role="tablist" aria-label="Choose lexicon">
              ${vocabs.map((v) => {
                const isActive = v.id === activeVocab?.id;
                // An inactive chip scopes the popover to that lexicon; the active
                // chip is a link to the full vocab view (new tab). So the first
                // click selects, a second click on the now-active chip opens.
                return isActive
                  ? html`<a
                      class="igt-vocab-pop__vocabtab is-active"
                      role="tab"
                      aria-selected="true"
                      href=${`#/vocabularies/${v.id}`}
                      target="_blank"
                      rel="noopener"
                      title=${`Open “${v.name}” in a new tab`}
                      @click=${(e) => e.stopPropagation()}
                      ><span class="igt-vocab-pop__vtab-name">${v.name}</span
                      ><span class="igt-vocab-pop__vtab-ext">↗</span></a
                    >`
                  : html`<button
                      type="button"
                      class="igt-vocab-pop__vocabtab"
                      role="tab"
                      aria-selected="false"
                      title=${`Switch to “${v.name}”`}
                      @click=${(e) => {
                        e.stopPropagation();
                        selectVocab(v.id);
                      }}
                    >
                      <span class="igt-vocab-pop__vtab-name">${v.name}</span>
                    </button>`;
              })}
            </div>`
          : nothing}
      </div>
    `;
  },

  // Morpheme type editor (popover footer row): metadata.morphType from FLEx's
  // exact inventory, or "—" for untyped. Pure metadata — geometry, precedence,
  // and the form are untouched; the display-only affix joints ("-"/"=") react
  // immediately.
  // A LINKED morpheme's type lives on its lexicon entry (the entry overrides
  // the token's cached type, see derive.js), so the row edits the entry —
  // for vocab maintainers; others see it read-only. Unlinked: the token's own.
  _morphTypeRow(morphemeId, currentItem) {
    const morph = (this.doc.layerInfo.morphemeTokenLayer?.tokens || []).find(
      (m) => m.id === morphemeId,
    );
    const linked = !!currentItem?.vocabId;
    const vocab = linked ? this.doc.vocabularies?.[currentItem.vocabId] : null;
    // The entry's type is its own, else its headword's. Linked, the row
    // shows that and nothing else: the token's cached type is not the
    // entry's, whatever the line draws from it.
    const fromItem = linked
      ? this._vocabMemoFor(currentItem.vocabId).morphTypeOf(currentItem.id)
      : null;
    const current = (linked ? fromItem : morph?.metadata?.morphType) ?? '';
    const canEditEntry = linked && !!vocab && this.canWriteVocab(vocab);
    const disabled = this.readOnly || (linked && !canEditEntry);
    const title = linked
      ? canEditEntry
        ? 'Type of the linked lexicon entry (applies to every morpheme linked to it)'
        : 'Type comes from the linked lexicon entry; only its maintainers can change it'
      : 'Type of this morpheme';
    return html`
      <label class="igt-vocab-pop__type" title=${title} @click=${(e) => e.stopPropagation()}>
        <span>${linked ? 'Type (entry)' : 'Type'}</span>
        <select
          ?disabled=${disabled}
          aria-label=${linked ? 'Lexicon entry morpheme type' : 'Morpheme type'}
          @change=${(e) => {
            e.stopPropagation();
            const value = e.target.value || null;
            // Through the op chain like every other edit: the doc drops a
            // mutation that overlaps one in flight.
            this._run(() =>
              linked
                ? this.doc.setVocabItemMorphType(currentItem.vocabId, currentItem.id, value)
                : this.doc.setMorphemeType(morphemeId, value),
            );
          }}
        >
          <option value="" ?selected=${current === ''}>—</option>
          ${morphTypeOptions(current).map(
            (t) =>
              html`<option value=${t} ?selected=${current === t}>${morphTypeLabel(t)}</option>`,
          )}
        </select>
      </label>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
