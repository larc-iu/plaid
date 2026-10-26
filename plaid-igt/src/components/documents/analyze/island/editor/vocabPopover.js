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
  createTally,
  foldDocument,
  mergeTally,
  precedentCounts,
  precedentForm,
} from '@/domain/precedent';
import { leavePrecedent, openPrecedent, precedentBase } from '@/domain/precedentCache';
import { sameFormUnlinked, sameFormUnanalyzed } from '@/domain/linkEverywhere.js';
import { numHtml } from './shared.js';
import { keys } from '@/lib/keymap.js';
import { countOf } from '@ui/lib/plural.js';

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
  // gloss guesses: the project-wide link and annotation-value tallies with
  // this document taken out (domain/precedentCache.js, which reads them once
  // per project), plus this document's own links and values folded live from
  // the derived sentences, so a decision made a moment ago already counts and
  // nothing is counted twice. Until the queries answer, everything ranks on
  // the document alone; the island re-renders when they land. A failed read
  // keeps it that way (popover and guesses still work).
  //
  // `check` asks the server whether anyone saved in the project since it was
  // counted, and counts it again if so (see the visibilitychange listener in
  // the constructor). Opening a document asks the same.
  _ensurePrecedent(check = false) {
    const pending = openPrecedent(this.doc, { check });
    // Asked on every render, and answered with the same promise until it
    // settles: one repaint per read, not one per render.
    if (!pending || pending === this._precedentPending) return;
    this._precedentPending = pending;
    pending.finally(() => {
      if (this._precedentPending === pending) this._precedentPending = null;
      if (!this._destroyed) this._render(true);
    });
  },

  // Called from destroy(): what this document now holds stands in for its
  // project rows in the next document opened, if it changed while open.
  // Read-only or not: an editor taken read-only by a look at the history or
  // by a run still closes the live document, with the edits made in it.
  // Whether it changed is the cache's to say (a history snapshot never did).
  _leavePrecedent() {
    if (!this.doc) return;
    const info = this.doc.layerInfo;
    leavePrecedent(this.doc, {
      wordFields: (info?.spanLayers?.word || []).map((l) => l.name),
      morphFields: (info?.spanLayers?.morpheme || []).map((l) => l.name),
      ignoredCfg: this._ignoredCfg,
    });
  },

  _precedentTally() {
    const base = precedentBase(this.doc, this._ignoredCfg);
    const dv = this.doc?.dataVersion;
    const memo = this._precedentMemo;
    if (!memo || memo.base !== base || memo.dv !== dv) {
      const info = this.doc?.layerInfo;
      const tally = base ? mergeTally(createTally(), base) : createTally();
      foldDocument(tally, this.doc?.sentences, {
        wordFields: (info?.spanLayers?.word || []).map((l) => l.name),
        morphFields: (info?.spanLayers?.morpheme || []).map((l) => l.name),
        ignoredCfg: this._ignoredCfg,
      });
      this._precedentMemo = { base, dv, tally };
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

  // The popover a project with no lexicon gets: one row, the word's analysis
  // onto the words nobody has analyzed, and the morph type when it is opened
  // from a morpheme.
  _spreadPopover(tokenId, formText, kind) {
    const like =
      kind === 'mwe' ? null : sameFormUnanalyzed(this.doc.sentences, tokenId, this._ignoredCfg);
    const pos = this._popoverPos;
    const posStyle = pos
      ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;`
      : '';
    return html`<div
      class="igt-vocab-pop"
      data-igt-pop
      role="dialog"
      aria-label=${`Analyze “${formText}”`}
      style=${posStyle}
      @click=${(e) => e.stopPropagation()}
      @keydown=${(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this._closePopover(true);
        }
      }}
    >
      ${like
        ? html`<button
            type="button"
            class="igt-vocab-pop__all"
            data-pop-autofocus
            title=${`Give the ${like.ids.length} unanalyzed “${like.word.content}” in this text this word’s morphemes and values`}
            @click=${(e) => {
              e.stopPropagation();
              this._analyzeEverywhere(tokenId, like, true);
            }}
          >
            Analyze every “${like.word.content}” in this text like this
            <span class="igt-vocab-pop__prec">×${like.ids.length}</span>
          </button>`
        : html`<div class="igt-vocab-pop__empty" data-pop-autofocus tabindex="-1">
            Nothing else in this text is spelled “${formText}” and unanalyzed.
          </div>`}
      ${kind === 'morpheme' ? this._morphTypeRow(tokenId, null) : nothing}
    </div>`;
  },

  _vocabPopover(tokenId, formText, currentItem, kind) {
    const vocabs = Object.values(this.doc.vocabularies || {});
    // A project with no lexicon has nothing to link to, and everything below
    // is about linking. What it can still offer is the word's own analysis,
    // spread over the words spelled the same, which needs no lexicon at all
    // and used to be unreachable because this popover never opened.
    if (!vocabs.length) return this._spreadPopover(tokenId, formText, kind);
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
    // A morpheme's chip lists the pair picker's rows (pairPicker.js), each a
    // sense and a value, from every vocabulary. A word's and an expression's
    // list entries.
    const pairs = kind === 'morpheme' ? this._chipPairs(tokenId, search) : null;
    const isMwe = kind === 'mwe';
    const precForm = isMwe ? formText : this._precedentForm(formText, kind);
    const { limited, truncated, best } = pairs
      ? { limited: pairs.rows, truncated: pairs.more, best: this._pairDefaultRow(pairs.rows) }
      : this._entryList(activeVocab, formText, kind, search, currentItem);
    // The form a new entry would get: the word/morpheme's surface with edge
    // punctuation trimmed by the project's own ignored-tokens rule
    // (`derechos.` → `derechos`; user decision 2026-08-26).
    const createForm = trimIgnoredEdges(formText || '', this._ignoredCfg);
    // A single "+ Create" row, into the active vocab, when there's a form.
    // Adding an entry needs only write access to the document, like linking
    // (acl-shared-vocab-writers b). Renaming and deleting are the
    // vocabulary's maintainers', and the popover offers neither.
    const canCreate = !!(createForm && activeVocab && !this.readOnly);
    // While the row is being edited the entry's form is whatever is typed.
    const editingCreate = canCreate && this._popoverCreateEdit != null;
    const effectiveForm = editingCreate ? this._popoverCreateEdit.trim() : createForm;
    // If the form already exists in the active vocab, the new entry would be
    // spelled like an existing one. Preview the number it would get (existing
    // count + 1) and say so, since a duplicate is usually a mis-click on the
    // existing entry. Only ENTRIES count, since a new one is an entry.
    // An entry whose parent is gone, or whose parent chain loops, is an
    // entry, as the sense tree reads it.
    const liveParent =
      canCreate && effectiveForm ? this._senseTreeFor(activeVocab.id).parentOf : null;
    const newFormDupes = liveParent
      ? (activeVocab.items || []).filter(
          (it) => it.form === effectiveForm && !liveParent.get(it.id),
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
          label: 'Gather into a multi-word expression',
          title: 'Gather this word with others into one multi-word expression',
          onSelect: () => this._startMweSelection(sentence.id, tokenId),
        });
      }
    }
    // Rows the keyboard can land on: every item, the create row, the extras.
    const total = limited.length + (canCreate ? 1 : 0) + extraRows.length;
    // The row the render picked, told apart from one the user moved to, so a
    // lexicon read landing while this is open picks again (see
    // _refreshVocabularies) only when the user has not.
    if (this._popoverActiveIndex == null) {
      // A pair list may start on no row (pairPicker.js _pairDefaultRow).
      this._popoverActiveIndex = pairs && best < 0 && !search.trim() ? -1 : Math.max(0, best);
      this._popoverPickedIndex = this._popoverActiveIndex;
    }
    const activeIdx = Math.min(this._popoverActiveIndex ?? 0, Math.max(0, total - 1));
    // The other tokens in this text that read the same and have no link. While
    // THIS token has none either, a row can take them all along with it ("all
    // ×3" on the highlighted row, Shift+Enter). Once it is linked they are the
    // "Link every…" row at the bottom. Never the default: see _linkEverywhere.
    const others = isMwe ? [] : sameFormUnlinked(this.doc.sentences, kind, formText, tokenId);
    // A token that already has a link can still take the others along: the
    // gesture used to fall through to the plain toggle there, which deleted
    // the link it was pressed on.
    const canTakeAll = others.length > 0;
    const allCount = others.length + (currentItem ? 0 : 1);
    const allTitle = currentItem
      ? `Link the ${others.length} other unlinked “${formText}” in this text · Shift+click or ${keys.words('popover.linkAll')}`
      : `Link this and the ${others.length} other unlinked “${formText}” in this text · Shift+click or ${keys.words('popover.linkAll')}`;
    // The actions, routed by mode: a word's or morpheme's own link, or the
    // multi-word expression's. `all` takes the others along.
    const act = {
      pick: (row, rf, all = false) =>
        this._pickPair(tokenId, pairs.field, row, formText, canTakeAll ? others : [], rf, all),
      confirm: (rf) =>
        isMwe ? this._confirmMwe(currentItem.linkId, rf) : this._confirmLink(tokenId, rf),
      toggle: (it, linked, rf, all = false) =>
        isMwe
          ? this._toggleMwe(it, linked, rf)
          : all && canTakeAll
            ? this._linkAll(tokenId, formText, it, others, rf, allCount)
            : this._toggleVocab(tokenId, it, linked, rf),
      create: (form, rf, all = false) =>
        isMwe
          ? this._createMwe(activeVocab.id, form, rf)
          : this._createVocab(
              tokenId,
              activeVocab.id,
              form,
              rf,
              all && canTakeAll ? { ids: others, formText } : null,
            ),
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
    const selectActive = (immediate = false, all = false) => {
      if (activeIdx < 0) return;
      if (pairs && activeIdx < limited.length) {
        act.pick(limited[activeIdx], true, all);
      } else if (activeIdx < limited.length) {
        const it = limited[activeIdx];
        const linked = currentItem && it.id === currentItem.id;
        if (linked && inferredCurrent) act.confirm(true);
        else act.toggle(it, linked, true, all);
      } else if (canCreate && activeIdx === limited.length) {
        // Enter on the create row opens the inline editor (edit the form
        // first); Ctrl/Cmd+Enter creates as-is, like a double-click.
        if (immediate) act.create(createForm, true, all);
        else this._openCreateEdit(createForm);
      } else {
        extraRows[activeIdx - limited.length - (canCreate ? 1 : 0)]?.onSelect();
      }
    };
    // Inline create editor keys: Enter creates (non-empty), Escape goes back
    // to the search box, Tab stays trapped in the dialog.
    const onCreateEditKey = (e) => {
      e.stopPropagation();
      // Creating is what this box is for, so only the "and link them all"
      // half of either chord says anything here.
      const takeAll = keys.which(['popover.createAndLinkAll', 'popover.linkAll'], e);
      if (e.key === 'Enter' || takeAll) {
        e.preventDefault();
        const v = (e.target.value || '').trim();
        if (v) act.create(v, true, !!takeAll);
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
        if (v) act.create(v, false, e.shiftKey);
        return;
      }
      // Shift+click creates as typed and takes the others along, like the chip.
      if (e.shiftKey && canTakeAll) {
        clearTimeout(this._createClickTimer);
        this._createClickTimer = null;
        act.create(createForm, false, true);
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
      // A bound chord is asked about BEFORE the arrows and Enter this panel
      // reads by position: rebinding one of these actions to Alt+Down left it
      // dead, because the row cursor took the key first.
      const bound = keys.which(
        ['popover.createAndLinkAll', 'popover.linkAll', 'popover.createNow'],
        e,
      );
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closePopover(true);
      } else if (!bound && e.key === 'ArrowDown') {
        e.preventDefault();
        this._movePopoverActive(1, total);
      } else if (!bound && e.key === 'ArrowUp') {
        e.preventDefault();
        this._movePopoverActive(-1, total);
      } else if (e.key === 'Enter' || bound) {
        e.preventDefault();
        // One chord asks for both at once, and it is a row in the table like
        // the other two rather than a Ctrl-and-Shift test made here.
        const both = bound === 'popover.createAndLinkAll';
        selectActive(
          both || keys.is('popover.createNow', e),
          both || keys.is('popover.linkAll', e),
        );
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } // trap focus in the search box
    };
    const selectVocab = (id) => {
      this._popoverVocabId = id;
      this._popoverActiveIndex = null; // another lexicon, another best row
      this._render(true);
      // The search box holds the keys (typing, the arrows, Enter), so a tab
      // chosen by click or by key hands focus back to it.
      this._focusPopover();
    };

    // `dir="ltr"` on the panel: it is chrome, not data, and reads one way
    // whatever the grid under it is doing, the way a menu does. The entry forms
    // inside it carry `dir="auto"` and decide for themselves.
    return html`
      <div
        class="igt-vocab-pop ${pairs ? 'igt-vocab-pop--pairs' : ''}"
        data-igt-pop
        style=${posStyle}
        role="dialog"
        dir="ltr"
        aria-label=${isMwe ? 'Link words to lexicon' : 'Link to lexicon'}
        @click=${(e) => e.stopPropagation()}
      >
        ${isMwe ? this._mweMembersStrip() : nothing}
        <input
          class="igt-vocab-pop__search"
          spellcheck="false"
          dir="auto"
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
                // A morpheme's pair row, or a word's or expression's entry row,
                // in the same shell.
                if (pairs) {
                  const linked = it.current && !!it.item;
                  return this._popRow({
                    i,
                    activeIdx,
                    cls: `igt-pair ${linked ? 'is-linked' : ''} ${it.context ? 'is-context' : ''}`,
                    depth: it.depth,
                    // Shift+click takes the others along, as Shift+Enter does.
                    onClick: (e) => act.pick(it, false, e.shiftKey),
                    main: this._pairRowCells(it, {
                      multiVocab: vocabs.length > 1,
                      entryLink: linked ? `#/vocabularies/${it.vocabId}?item=${it.itemId}` : null,
                      extra: html`${canTakeAll && i === activeIdx && it.named && it.itemId
                        ? this._takeAllMark(allTitle, others.length + (it.linkChange ? 1 : 0), () =>
                            act.pick(it, false, true),
                          )
                        : nothing}
                      ${linked
                        ? this._unlinkMark(() => this._toggleVocab(tokenId, it.item, true))
                        : nothing}`,
                    }),
                  });
                }
                const linked = currentItem && it.id === currentItem.id;
                const confirmable = linked && inferredCurrent;
                return this._popRow({
                  i,
                  activeIdx,
                  cls: `${linked ? 'is-linked' : ''} ${it._context ? 'is-context' : ''}`,
                  depth: it._depth,
                  // Shift+click is the chip's gesture on the whole row, as
                  // Shift+Enter is from the keyboard.
                  onClick: (e) =>
                    confirmable ? act.confirm() : act.toggle(it, linked, false, e.shiftKey),
                  main: html`<span class="igt-vocab-pop__main" dir="auto">
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
                            title=${`“${precForm}” was linked to this entry ${countOf(it._prec, 'time')} in this project`}
                            >×${it._prec}</span
                          >`
                        : nothing}
                      ${confirmable ? html`<span class="igt-vocab-pop__ok">accept</span>` : nothing}
                      ${canTakeAll && i === activeIdx
                        ? this._takeAllMark(allTitle, others.length + 1, () =>
                            act.toggle(it, false, false, true),
                          )
                        : nothing}
                      ${linked ? this._unlinkMark(() => act.toggle(it, true)) : nothing}
                    </span>
                    ${it._detail
                      ? html`<span class="igt-vocab-pop__detail">${it._detail}</span>`
                      : nothing}`,
                });
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
                ? 'Enter to create the entry as typed · Esc to cancel'
                : 'Click to edit the form before creating · double-click to create as is'}
              @click=${onCreateClick}
            >
              ${editingCreate
                ? html`+ Create
                    <input
                      class="igt-vocab-pop__create-input"
                      spellcheck="false"
                      dir="auto"
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
              ${canTakeAll && activeIdx === limited.length
                ? html`<span
                    class="igt-vocab-pop__take-all"
                    role="button"
                    tabindex="-1"
                    title=${allTitle}
                    @click=${(e) => {
                      e.stopPropagation();
                      clearTimeout(this._createClickTimer);
                      this._createClickTimer = null;
                      if (effectiveForm) act.create(effectiveForm, false, true);
                    }}
                    >all ×${others.length + 1}</span
                  >`
                : nothing}
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
          if (!currentItem || !others.length) return nothing;
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
        ${(() => {
          // The whole word's analysis onto the other words spelled the same
          // that nobody has touched. Offered from the word and from any of
          // its morphemes, once there is an analysis a person stands behind.
          const like = isMwe
            ? null
            : sameFormUnanalyzed(this.doc.sentences, tokenId, this._ignoredCfg);
          if (!like) return nothing;
          const form = like.word.content;
          return html`<button
            type="button"
            class="igt-vocab-pop__all"
            title=${`Give the ${like.ids.length} unanalyzed “${form}” in this text this word’s morphemes, links and values`}
            @click=${(e) => {
              e.stopPropagation();
              this._analyzeEverywhere(tokenId, like, true);
            }}
          >
            Analyze every “${form}” in this text like this
            <span class="igt-vocab-pop__prec">×${like.ids.length}</span>
          </button>`;
        })()}
        ${kind === 'morpheme'
          ? this._morphTypeRow(tokenId, currentItem)
          : isMwe
            ? this._mweTypeRow(currentItem)
            : nothing}
        ${vocabs.length
          ? html`<div
              class="igt-vocab-pop__vocabsel"
              role="tablist"
              aria-label=${pairs ? 'Create in' : 'Choose lexicon'}
            >
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
                      title=${pairs ? `Create in “${v.name}”` : `Switch to “${v.name}”`}
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

  // A row of the list: a button the pointer makes active and a click picks,
  // indented under its headword. `main` is what it shows.
  _popRow({ i, activeIdx, cls, depth, onClick, main }) {
    return html`<button
      type="button"
      class="igt-vocab-pop__item ${cls} ${i === activeIdx ? 'is-active' : ''}"
      style=${depth ? `--igt-depth:${depth}` : ''}
      @mousemove=${(e) => {
        if (!this._pointerMoved(e)) return;
        if (this._popoverActiveIndex !== i) {
          this._popoverActiveIndex = i;
          this._render(true);
        }
      }}
      @click=${(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      ${main}
    </button>`;
  },

  // "all ×N" on the active row: link the other unlinked tokens reading the same.
  _takeAllMark(title, count, onClick) {
    return html`<span
      class="igt-vocab-pop__take-all"
      role="button"
      tabindex="-1"
      title=${title}
      @click=${(e) => {
        e.stopPropagation();
        onClick();
      }}
      >all ×${count}</span
    >`;
  },

  _unlinkMark(onClick) {
    return html`<span
      class="igt-vocab-pop__x"
      role="button"
      tabindex="-1"
      @click=${(e) => {
        e.stopPropagation();
        onClick();
      }}
      >unlink</span
    >`;
  },

  // A word's or an expression's list: the vocabulary's entries ranked
  // against the form or the typed search (vocabRank.js), grouped by headword,
  // capped, and the row the keyboard starts on.
  _entryList(activeVocab, formText, kind, search, currentItem) {
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
      items.length = 0;
      for (const it of phrases) items.push(it);
      for (const it of others) items.push(it);
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
    const entryRows = grouped.slice(0, 30).map((r) => ({
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
    const truncated = items.length - entryRows.filter((r) => !r._context).length;
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
    const best = entryRows.findIndex((r) => !r._context && r.id === first?.id);
    return { limited: entryRows, truncated, best };
  },

  // Morpheme type editor (popover footer row): metadata.morphType from FLEx's
  // exact inventory, or "—" for untyped. Pure metadata — geometry, precedence,
  // and the form are untouched; the display-only affix joints ("-"/"=") react
  // immediately.
  // A morpheme linked to an entry that has a type goes by the entry's (R2),
  // so the row shows and edits the entry, for vocab maintainers, and says the
  // change applies to every use. Linked to an entry with none, it goes by its
  // own, so the row shows and edits that, as on an unlinked morpheme
  // (REV-CLITIC CL-3).
  _morphTypeRow(morphemeId, currentItem) {
    const morph = (this.doc.layerInfo.morphemeTokenLayer?.tokens || []).find(
      (m) => m.id === morphemeId,
    );
    const linked = !!currentItem?.vocabId;
    const vocab = linked ? this.doc.vocabularies?.[currentItem.vocabId] : null;
    const fromItem = linked
      ? this._vocabMemoFor(currentItem.vocabId).morphTypeOf(currentItem.id)
      : null;
    const editsEntry = !!fromItem;
    const current = (editsEntry ? fromItem : morph?.metadata?.morphType) || '';
    const canEditEntry = editsEntry && !!vocab && this.canManageVocab(vocab);
    const disabled = this.readOnly || (editsEntry && !canEditEntry);
    const title = !editsEntry
      ? 'Type of this morpheme'
      : canEditEntry
        ? 'Type of the linked lexicon entry'
        : 'Type of the linked lexicon entry. Only its maintainers can change it.';
    return html`
      <label class="igt-vocab-pop__type" title=${title} @click=${(e) => e.stopPropagation()}>
        <span>${editsEntry ? 'Type (entry)' : 'Type'}</span>
        <select
          ?disabled=${disabled}
          aria-label=${editsEntry ? 'Lexicon entry morpheme type' : 'Morpheme type'}
          @change=${(e) => {
            e.stopPropagation();
            const value = e.target.value || null;
            if (editsEntry)
              this.doc.setVocabItemMorphType(currentItem.vocabId, currentItem.id, value);
            else this.doc.setMorphemeType(morphemeId, value);
          }}
        >
          <option value="" ?selected=${current === ''}>—</option>
          ${morphTypeOptions(current).map(
            (t) =>
              html`<option value=${t} ?selected=${current === t}>${morphTypeLabel(t)}</option>`,
          )}
        </select>
      </label>
      ${canEditEntry
        ? html`<div class="igt-vocab-pop__type-note">Applies to every use of this entry.</div>`
        : nothing}
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
