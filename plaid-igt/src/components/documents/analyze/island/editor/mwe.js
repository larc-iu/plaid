import { html, nothing } from 'lit-html';
import { PROV_STATES } from '@larc-iu/plaid-client';
import { isTokenIgnored, trimIgnoredEdges } from '@/domain/igtConfig';
import { morphTypeLabel, morphTypeOptions } from '@/domain/affixMarkers';
import { joinMweForm, mweMorphType } from '@/domain/mwe';
import { notifyInfo } from '@/utils/feedback';
import { EMPTY_SET, numHtml, provClass } from './shared.js';

// Multi-word expressions: gathering words into one link, the bracket and its
// lanes, and the popover for the expression as a whole.
export const mwe = {
  // A multi-word expression (MWE) is one lexicon entry linked from two or more
  // words at once; derive.js hands every word column its pieces of the
  // bracket (see domain/mwe.js). Gathering the words is a small mode:
  // Shift+click a word (or Shift+←/→ from one of its cells) starts it, more of
  // the same adds words, Enter opens the lexicon popover for the whole set,
  // Esc drops it. An existing MWE opens from its bracket label, and while its
  // popover is open the same gestures change which words it covers.
  _canLinkMwe() {
    return !this.readOnly && Object.keys(this.doc.vocabularies || {}).length > 0;
  },

  _clearMweSelection() {
    if (!this._mweSel) return;
    this._mweSel = null;
    this._render(true);
  },

  // The words highlighted as members: the selection under way, else the
  // members of the MWE whose popover is open.
  _selectedWordIds() {
    if (this._mweSel) return this._mweSel.tokenIds;
    const open = this._openMwe();
    return open ? new Set(open.memberTokenIds) : EMPTY_SET;
  },

  // The derived MWE behind an open MWE popover, or null (none open, or the
  // popover is for words not yet linked).
  _openMwe() {
    if (this._popover?.kind !== 'mwe' || this._popover.tokenId === 'mwe:new') return null;
    return this._mweByLink(this._popover.tokenId.slice('mwe:'.length));
  },

  _mweByLink(linkId) {
    for (const s of this.doc.sentences) {
      const hit = (s.mwes || []).find((m) => m.linkId === linkId);
      if (hit) return hit;
    }
    return null;
  },

  // The selection's word tokens, in text order.
  _mweSelTokens() {
    const sel = this._mweSel;
    if (!sel) return [];
    const sentence = this.doc.sentenceLookup.get(sel.sentenceId);
    return (sentence?.tokens || []).filter((t) => sel.tokenIds.has(t.id));
  },

  // The words of the open MWE, else of the selection, as token ids in order.
  _mweTargetIds() {
    const open = this._openMwe();
    return open ? [...open.memberTokenIds] : this._mweSelTokens().map((t) => t.id);
  },

  // An MWE's entry in the shape the popover and the homonym helper expect.
  _mweItem(mwe) {
    return {
      ...mwe.item,
      vocabId: mwe.vocabId,
      vocabName: mwe.vocabName,
      linkId: mwe.linkId,
      prov: mwe.prov,
    };
  },

  // The member surfaces, spaced, each with its edge punctuation trimmed by the
  // project's ignored-tokens rule — the form a new entry is offered.
  _mweWords(tokenIds) {
    return joinMweForm(
      tokenIds.map((id) =>
        trimIgnoredEdges(this.doc.tokenLookup.get(id)?.content ?? '', this._ignoredCfg),
      ),
    );
  },

  // The morph type a new entry for these words gets.
  _mweTypeFor(tokenIds) {
    const first = this.doc.tokenLookup.get(tokenIds[0]);
    const sentence = first && this.doc.findSentenceForToken(first);
    const posMap = sentence ? this.doc.tokenPositionMaps.get(sentence.id) : null;
    return mweMorphType(tokenIds.map((id) => posMap?.get(id) ?? 0));
  },

  // Start (or extend) a selection from `wordId` and move its cursor one word
  // left or right within the sentence, skipping words the project ignores
  // (punctuation). The word the cursor lands on joins the selection, unless
  // `skip` (Ctrl held), which leaves a gap for a discontiguous expression.
  _mweStep(wordId, dir, { skip = false } = {}) {
    const token = this.doc.tokenLookup.get(wordId);
    const sentence = token && this.doc.findSentenceForToken(token);
    if (!sentence) return;
    let sel = this._mweSel;
    if (!sel || sel.sentenceId !== sentence.id) {
      sel = this._mweSel = {
        sentenceId: sentence.id,
        tokenIds: new Set([wordId]),
        cursorId: wordId,
      };
    }
    const words = sentence.tokens.filter((t) => !isTokenIgnored(t.content, this._ignoredCfg));
    let i = words.findIndex((t) => t.id === sel.cursorId);
    if (i < 0) i = words.findIndex((t) => t.id === wordId);
    const next = words[i + dir];
    if (next) {
      sel.cursorId = next.id;
      if (!skip) sel.tokenIds.add(next.id);
    }
    this._render(true);
  },

  // Shift+click on a word: toggle it in the selection, starting one when none
  // is under way. While an existing MWE's popover is open, the toggle changes
  // that MWE's words instead.
  _toggleMweWord(sentenceId, wordId) {
    const open = this._openMwe();
    if (open) {
      const ids = new Set(open.memberTokenIds);
      if (ids.has(wordId)) ids.delete(wordId);
      else ids.add(wordId);
      this._setMweMembers(open, [...ids]);
      return;
    }
    let sel = this._mweSel;
    if (!sel || sel.sentenceId !== sentenceId) {
      sel = this._mweSel = { sentenceId, tokenIds: new Set(), cursorId: wordId };
    }
    if (sel.tokenIds.has(wordId)) sel.tokenIds.delete(wordId);
    else sel.tokenIds.add(wordId);
    sel.cursorId = wordId;
    if (!sel.tokenIds.size) this._mweSel = null;
    if (this._popover?.kind === 'mwe') {
      // The popover for the words so far stays open and follows them.
      if (!this._mweSel) this._closePopover();
      else this._render(true);
      this._focusPopover();
      return;
    }
    // Focus lands on the pending label, so Enter opens the popover.
    if (this._mweSel) this._pendingFocus = { vocabOpener: 'mwe:new' };
    this._render(true);
  },

  // From the single-word popover: begin gathering an MWE around this word.
  _startMweSelection(sentenceId, wordId) {
    this._closePopover();
    this._mweSel = { sentenceId, tokenIds: new Set([wordId]), cursorId: wordId };
    this._pendingFocus = { vocabOpener: 'mwe:new' };
    this._render(true);
  },

  // Keys shared by cells, chips and bracket labels. Returns true when the key
  // belonged to the selection. Marks the event so the container handler does
  // not run it a second time after a cell's own handler already has.
  _mweKeydown(e) {
    e.igtMweSeen = true;
    if (!this._canLinkMwe()) return false;
    const sel = this._mweSel;
    if (e.key === 'Enter' && sel && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (sel.tokenIds.size >= 2) this._openMwePopover();
      else notifyInfo('Add another word first: Shift+click it, or Shift+→ from a cell');
      return true;
    }
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !e.shiftKey || e.altKey || e.metaKey)
      return false;
    const el = e.target;
    const wordId = el?.closest?.('[data-word-col]')?.dataset.wordCol ?? sel?.cursorId;
    if (!wordId) return false;
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    if (isInput && !sel) {
      // Only from a collapsed caret at the value's edge, the way ←/→ leave a
      // cell; inside a value Shift+arrow still selects text.
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (start !== end) return false;
      const atEdge = e.key === 'ArrowLeft' ? start === 0 : end === (el.value ?? '').length;
      if (!atEdge) return false;
    }
    e.preventDefault();
    e.stopPropagation();
    this._mweStep(wordId, e.key === 'ArrowRight' ? 1 : -1, { skip: e.ctrlKey });
    return true;
  },

  // The lexicon popover for the words gathered so far, anchored to the
  // pending bracket's label on the first of them.
  _openMwePopover() {
    if (this._mweSelTokens().length < 2) return;
    const anchor = this.container.querySelector('[data-vocab-opener="mwe:new"]');
    this._openPopover('mwe:new', 'mwe', anchor);
  },

  // An existing MWE's popover (from a single-word popover's "In: …" row),
  // anchored to its bracket label.
  _openMweByLink(linkId) {
    this._closePopover();
    const key = `mwe:${linkId}`;
    const anchor = this.container.querySelector(`[data-vocab-opener="${key}"]`);
    if (!anchor) return;
    this._openPopover(key, 'mwe', anchor);
  },

  // A popover row: link the gathered words (new), point an existing MWE at
  // another entry, or unlink it.
  async _toggleMwe(item, isLinked, returnFocus = false) {
    const open = this._openMwe();
    const tokens = this._mweTargetIds();
    this._closePopover(returnFocus);
    if (open) {
      await this._runThenFocus({ mweOf: tokens[0] }, () =>
        isLinked ? this.doc.unlinkMwe(open.linkId) : this.doc.relinkMwe(open.linkId, item.id),
      );
      return;
    }
    if (tokens.length < 2) return;
    this._mweSel = null;
    await this._runThenFocus({ mweOf: tokens[0] }, () => this.doc.linkMwe(tokens, item.id));
  },

  _confirmMwe(linkId, returnFocus = false) {
    const first = this._mweByLink(linkId)?.memberTokenIds[0];
    this._closePopover(returnFocus);
    this._pulseLink(`mwe:${linkId}`);
    this._runThenFocus({ mweOf: first }, () => this.doc.confirmMweLink(linkId));
  },

  // "+ Create" in MWE mode: a new entry typed phrase / discontiguous phrase,
  // linked from the words (replacing an existing MWE's link, if that is what
  // the popover was opened on).
  async _createMwe(vocabId, form, returnFocus = false) {
    const open = this._openMwe();
    const tokens = this._mweTargetIds();
    this._closePopover(returnFocus);
    if (!form || tokens.length < 2) return;
    const metadata = { morphType: this._mweTypeFor(tokens) };
    this._mweSel = null;
    await this._runThenFocus({ mweOf: tokens[0] }, () =>
      this.doc.createAndLinkMwe(tokens, vocabId, form, metadata, open?.linkId ?? null),
    );
  },

  // Re-cover an existing MWE with different words. The link is remade (a new
  // id), so its popover closes; focus lands on the new bracket's label.
  _setMweMembers(mwe, tokenIds) {
    this._closePopover();
    const sorted = [...tokenIds].sort(
      (a, b) =>
        (this.doc.tokenLookup.get(a)?.begin ?? 0) - (this.doc.tokenLookup.get(b)?.begin ?? 0),
    );
    const first = sorted[0] ?? mwe.memberTokenIds[0];
    this._runThenFocus({ mweOf: first }, () => this.doc.setMweMembers(mwe.linkId, sorted));
  },

  // × on a member in the popover's strip.
  _removeMweMember(wordId) {
    const open = this._openMwe();
    if (open) {
      this._setMweMembers(
        open,
        open.memberTokenIds.filter((id) => id !== wordId),
      );
      return;
    }
    const sel = this._mweSel;
    if (!sel) return;
    sel.tokenIds.delete(wordId);
    if (sel.tokenIds.size < 2) {
      // Too few words for the popover; the pending label carries on.
      this._closePopover();
      if (!sel.tokenIds.size) this._mweSel = null;
      else this._pendingFocus = { vocabOpener: 'mwe:new' };
    }
    this._render(true);
    if (this._popover) this._focusPopover();
  },

  // Shift+click (or any click while gathering) on a word's form.
  // Where the Tokenize tab opens next: the sentence of the cell or word form
  // just focused, and the word's start. Written under a key the Tokenize tab
  // reads when it mounts, which a tab switch does, so the hand-off works by
  // the tab as well as by Alt+click. The mirror of what Tokenize writes for
  // this tab under `igt:focus-sentence`.
  _rememberForTokenize(el) {
    const sentenceId = el?.closest?.('.igt-sentence')?.dataset?.sentenceId;
    if (!sentenceId) return;
    const [kind, targetId] = (el.dataset?.cellKey || '').split(':');
    const wordId =
      el.dataset?.word ??
      el.closest?.('[data-word-col]')?.dataset?.wordCol ??
      (kind === 'wa' || kind === 'or' ? targetId : null);
    const sentence = (this.doc.sentences || []).find((s) => s.id === sentenceId);
    const begin = sentence?.tokens?.find((t) => t.id === wordId)?.begin ?? null;
    try {
      sessionStorage.setItem(
        'igt:focus-tokenize',
        JSON.stringify({ docId: this.doc.id, sentenceId, begin }),
      );
    } catch {
      /* noop */
    }
  },

  _onWordFormClick(e, sentence, token) {
    // Alt+click: this word on the Tokenize tab. (Shift+click gathers a
    // multi-word expression, so it could not be the same key as over there.)
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      this._rememberForTokenize(e.currentTarget);
      window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: { tab: 'tokenize' } }));
      return;
    }
    if (!this._canLinkMwe()) return;
    const gathering = !!this._mweSel || !!this._openMwe();
    if (!e.shiftKey && !gathering) return;
    e.preventDefault();
    e.stopPropagation();
    this._toggleMweWord(sentence.id, token.id);
  },

  // What a word column draws for the sentence's MWE lanes (and the selection
  // under way): the LINES, laid over the whole column, and the LABEL rows,
  // which sit in the word's own stack so that a long entry form widens its
  // column instead of running past the band and getting clipped.
  _mweBrackets(token, sctx) {
    const rules = [];
    const rows = [];
    const add = (piece, lane, mwe) => {
      if (piece !== 'solo') rules.push(this._mweRule(piece, lane, mwe));
      if (piece === 'start' || piece === 'solo') rows[lane] = this._mweLabel(mwe, token);
    };
    (token.mwePieces || []).forEach((p, lane) => {
      if (p) add(p.piece, lane, p.mwe);
    });
    const pend = sctx.pending?.[sctx.posMap.get(token.id)];
    if (pend) add(pend, sctx.lanes, null);
    const laneCount = sctx.lanes + (sctx.pending ? 1 : 0);
    const laneRows = [];
    for (let lane = 0; lane < laneCount; lane++) {
      laneRows.push(html`<span class="igt-vocab__mwe-lane">${rows[lane] ?? nothing}</span>`);
    }
    return { rules, laneRows };
  },

  _mweKey(mwe) {
    return mwe ? `mwe:${mwe.linkId}` : 'mwe:new';
  },

  // The provenance modifier for an MWE's pieces: pending while gathering,
  // else the link's machine / verified state, plain for a person's link.
  _mweState(mwe) {
    if (!mwe) return 'pending';
    return mwe.prov === PROV_STATES.HUMAN ? null : mwe.prov;
  },

  // One column's stretch of one line: full column width, inset at the ends,
  // dotted under a skipped word.
  _mweRule(piece, lane, mwe) {
    const cls = ['igt-mwe', `igt-mwe--${piece}`, provClass('igt-mwe', this._mweState(mwe))]
      .filter(Boolean)
      .join(' ');
    return html`<span class=${cls} style=${`--igt-lane:${lane}`} data-mwe=${this._mweKey(mwe)}
      ><span class="igt-mwe__rule"></span
    ></span>`;
  },

  // The label on the first member: the MWE's opener (a real button, in the
  // review sweep when machine-made), or what to do next while gathering.
  _mweLabel(mwe, token) {
    const key = this._mweKey(mwe);
    const state = this._mweState(mwe);
    const open = this._popover?.kind === 'mwe' && this._popover.tokenId === key;
    const canLink = this._canLinkMwe();
    let content;
    let title;
    if (mwe) {
      const item = this._mweItem(mwe);
      const sub = this._itemNumber(item);
      content = html`${mwe.item.form}${numHtml(sub, 'igt-vocab')}`;
      const words = this._mweWords(mwe.memberTokenIds);
      title = `“${words}” ${this._linkStateText(state, mwe.provOrigin, mwe.item.form, canLink)}`;
    } else {
      const n = this._mweSel?.tokenIds.size ?? 0;
      content = n >= 2 ? html`${n} words · <kbd>↵</kbd>` : html`add words…`;
      title =
        n >= 2
          ? 'Enter links these words to one entry · Shift+click adds or removes a word · Esc drops them'
          : 'Shift+click a word, or Shift+→ from a cell, to gather it into the multi-word expression · Esc drops it';
    }
    let popover = nothing;
    if (open) {
      const tokens = this._mweTargetIds();
      popover = this._vocabPopover(
        key,
        this._mweWords(tokens),
        mwe ? this._mweItem(mwe) : null,
        'mwe',
      );
    }
    return html`<button
        type="button"
        class="igt-mwe__label ${provClass('igt-mwe__label', state)}"
        data-vocab-opener=${key}
        data-pop-opener=${`vocab:${key}`}
        data-mwe=${key}
        data-mwe-first=${token.id}
        ?disabled=${!canLink}
        title=${title}
        @click=${(e) => {
          e.stopPropagation();
          if (open) this._closePopover();
          else if (mwe) this._openPopover(key, 'mwe', e.currentTarget);
          else this._openMwePopover();
        }}
      >
        ${content}</button
      >${popover}`;
  },

  // The member words at the top of the popover in MWE mode, each removable.
  _mweMembersStrip() {
    const tokens = this._mweTargetIds()
      .map((id) => this.doc.tokenLookup.get(id))
      .filter(Boolean);
    return html`
      <div class="igt-vocab-pop__members" aria-label="Words in this multi-word expression">
        ${tokens.map(
          (t) =>
            html`<span class="igt-vocab-pop__member"
              >${t.content}<button
                type="button"
                class="igt-vocab-pop__member-x"
                title=${`Remove “${t.content}” from the multi-word expression`}
                aria-label=${`Remove ${t.content}`}
                @click=${(e) => {
                  e.stopPropagation();
                  this._removeMweMember(t.id);
                }}
              >
                ×
              </button></span
            >`,
        )}
      </div>
      <div class="igt-vocab-pop__hintline">Shift+click a word to add or remove it</div>
    `;
  },

  // The popover's type row in MWE mode: an existing entry's type (editable by
  // the vocab's maintainers), or the type a new entry will get.
  _mweTypeRow(currentItem) {
    const linked = !!currentItem?.vocabId;
    const vocab = linked ? this.doc.vocabularies?.[currentItem.vocabId] : null;
    const preset = this._mweTypeFor(this._mweTargetIds());
    const current = linked
      ? (this._vocabMemoFor(currentItem.vocabId).morphTypeOf(currentItem.id) ?? '')
      : preset;
    const canEditEntry = linked && !!vocab && this.canWriteVocab(vocab);
    const title = linked
      ? canEditEntry
        ? 'Type of the linked lexicon entry'
        : 'Type comes from the linked lexicon entry; only its maintainers can change it'
      : 'The type a new entry gets: multi-word expression';
    return html`
      <label class="igt-vocab-pop__type" title=${title} @click=${(e) => e.stopPropagation()}>
        <span>${linked ? 'Type (entry)' : 'Type'}</span>
        <select
          ?disabled=${this.readOnly || !canEditEntry}
          aria-label="Lexicon entry type"
          @change=${(e) => {
            e.stopPropagation();
            const value = e.target.value || null;
            this._run(() =>
              this.doc.setVocabItemMorphType(currentItem.vocabId, currentItem.id, value),
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
