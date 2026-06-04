// Vanilla-JS interlinear ("Analyze") editor island.
//
// Framework-agnostic: consumes an IgtDocument via subscribe()/getSnapshot and
// renders the interlinear grid with lit-html. No React. Mounted by the thin
// AnalyzeIsland.jsx wrapper, but could be mounted by anything.
//
// Why an island: the grid is deeply nested (sentence > token > morpheme >
// annotation) and keystroke-heavy. React reconciliation through that tree
// fights focus/IME on every keystroke. Here we own the DOM: editable cells are
// uncontrolled inputs, we re-render only when the document's *data* actually
// changes (doc.dataVersion, not every emit), and the uncontrolledValue
// directive never overwrites an input the user is actively editing.

import { render, html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { live } from 'lit-html/directives/live.js';
import { directive, Directive, PartType } from 'lit-html/directive.js';
import './igt-editor.css';

// Small Levenshtein for ranking lexicon items by similarity to a token's form.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

// ---- uncontrolledValue: set input.value only when the input is NOT focused.
// Keeps programmatic changes (split/merge form rewrites, reloads) reflected
// while never clobbering text the user is mid-edit on.
class UncontrolledValueDirective extends Directive {
  constructor(partInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error('uncontrolledValue must be used as an element directive');
    }
  }
  update(part, [value]) {
    const el = part.element;
    const v = value ?? '';
    if (el && document.activeElement !== el && el.value !== v) el.value = v;
    return this.render(value);
  }
  render() { return nothing; }
}
const uncontrolledValue = directive(UncontrolledValueDirective);

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isTokenIgnored(content, cfg) {
  if (!cfg) return false;
  if (cfg.type === 'unicodePunctuation') {
    if ([...(content || '')].every((c) => PUNCT_RE.test(c))) {
      return !(cfg.whitelist || []).includes(content);
    }
    return false;
  }
  if (cfg.type === 'blacklist') return (cfg.blacklist || []).includes(content);
  return false;
}

const morphFormOf = (m) =>
  m.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form')
    ? (m.metadata.form ?? '')
    : (m.content ?? '');

export class IgtEditor {
  constructor(container, doc, { readOnly = false } = {}) {
    this.container = container;
    this.doc = doc;
    this.readOnly = readOnly;
    this._lastDataVersion = -1;
    this._pendingFocus = null;
    // All doc mutations are funneled through this promise chain so they run
    // strictly sequentially. IgtDocument._withSaving is single-flight (it drops
    // a call that overlaps an in-flight one), and the structural handlers below
    // optimistically touch the DOM — serializing here guarantees no mutation is
    // ever silently dropped while the DOM was already changed (review H1).
    this._opChain = Promise.resolve();
    // Vocab-link popover UI state (not document data — toggling forces a render).
    this._popover = null; // { tokenId, kind } | null
    this._popoverPos = null; // { left, top } fixed-position coords (escapes the grid's overflow clip)
    this._popoverSearch = '';
    this._onChange = () => this._scheduleRender();
    this._unsub = doc.subscribe(this._onChange);
    // Any click outside an opener/popover (those stopPropagation) closes it.
    this._onDocClick = () => this._closePopover();
    document.addEventListener('click', this._onDocClick);
    // The popover is position:fixed (computed once at open); scrolling the page or
    // the grid, or resizing, would detach it from its column — so close it instead.
    // Capture phase catches the grid's own scroll. No-op when no popover is open.
    this._onWinChange = () => this._closePopover();
    window.addEventListener('scroll', this._onWinChange, true);
    window.addEventListener('resize', this._onWinChange);
    this._render(true);
  }

  setReadOnly(ro) {
    if (ro === this.readOnly) return;
    // Flush a focused field's pending blur-commit BEFORE flipping the flag — the
    // commit handlers (_commitField/_commitMorphForm/_commitPlaceholder) early-
    // return when readOnly, so blurring after setting it would silently drop the
    // in-progress edit at the read-only/time-travel transition.
    if (this.container.contains(document.activeElement)) document.activeElement.blur();
    this.readOnly = ro;
    // Close any open vocab popover — its openers are disabled in read-only mode.
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._render(true);
  }

  destroy() {
    if (this._unsub) this._unsub();
    this._unsub = null;
    document.removeEventListener('click', this._onDocClick);
    window.removeEventListener('scroll', this._onWinChange, true);
    window.removeEventListener('resize', this._onWinChange);
    render(nothing, this.container);
  }

  // ---- vocab popover ----
  _openPopover(tokenId, kind, anchorEl) {
    this._popover = { tokenId, kind };
    this._popoverSearch = '';
    this._popoverPos = this._computePopoverPos(anchorEl);
    this._render(true);
  }
  // Position the popover (210px wide) below the opener as fixed coords, clamped
  // to the viewport — so edge columns don't overflow and the grid's overflow-x
  // scroll container can't clip it.
  _computePopoverPos(anchorEl) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = 210, Hest = 280, pad = 8;
    let left = r.left + r.width / 2 - W / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - W - pad));
    let top = r.bottom + 4;
    if (top + Hest > window.innerHeight) {
      const above = r.top - Hest - 4;
      // Flip above if it fits; otherwise (viewport too short either way) clamp
      // into view so the search box + create button stay reachable.
      top = above > pad ? above : Math.max(pad, window.innerHeight - Hest - pad);
    }
    return { left, top };
  }
  _closePopover() {
    if (!this._popover) return;
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._render(true);
  }
  async _toggleVocab(tokenId, item, isLinked) {
    this._closePopover();
    if (isLinked) await this._run(() => this.doc.unlinkVocab(tokenId));
    else await this._run(() => this.doc.linkVocab(tokenId, item.id));
  }
  async _createVocab(tokenId, vocabId, form) {
    this._closePopover();
    if (!form) return;
    await this._run(() => this.doc.createAndLinkVocabItem(tokenId, vocabId, form));
  }

  _scheduleRender() {
    if (this.doc.dataVersion === this._lastDataVersion) return;
    this._render();
  }

  // Enqueue a doc mutation thunk so it runs after any in-flight one. Returns a
  // promise of the thunk's result (true/false from the doc method) so callers
  // can restore optimistic DOM on failure. Chain never breaks on error.
  _run(fn) {
    const next = this._opChain.then(() => fn());
    this._opChain = next.catch(() => {});
    return next;
  }

  _render(force = false) {
    if (!force && this.doc.dataVersion === this._lastDataVersion) return;
    this._lastDataVersion = this.doc.dataVersion;
    // Defensively clear any stale suppress-commit flags so a sticky flag can't
    // swallow a later legitimate edit on a reused node (review H2).
    this.container
      .querySelectorAll('[data-suppress-commit]')
      .forEach((el) => { delete el.dataset.suppressCommit; });
    this.container.classList.toggle('igt-island--readonly', !!this.readOnly);
    render(this._template(), this.container);
    this._restorePendingFocus();
  }

  _restorePendingFocus() {
    const pf = this._pendingFocus;
    this._pendingFocus = null;
    if (!pf) return;
    // If the user already moved focus into another field while the structural op
    // was in flight, don't yank it back to the computed target (review: focus theft).
    const active = document.activeElement;
    if (active && active !== this.container && this.container.contains(active)
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      return;
    }
    let el = null;
    if (pf.placeholderWord) {
      el = this.container.querySelector(`.igt-morph-field--placeholder[data-word="${pf.placeholderWord}"]`);
    } else if (pf.wordId != null && pf.precedence != null) {
      el = this.container.querySelector(`.igt-morph-field[data-word="${pf.wordId}"][data-prec="${pf.precedence}"]`);
    }
    if (!el) return;
    el.focus();
    const c = pf.cursor === 'end' ? el.value.length : (typeof pf.cursor === 'number' ? pf.cursor : el.value.length);
    try { el.setSelectionRange(c, c); } catch { /* not selectable */ }
  }

  // ---- field event helpers ----
  _onFieldFocus = (e) => {
    e.target.dataset.orig = e.target.value;
    try { e.target.select(); } catch { /* noop */ }
  };

  // Morpheme form fields must NOT select-all on focus: the split handler reads
  // the caret position, and a select-all would make a stray '-' split at offset
  // 0 (empty left morpheme) — review M3. Just record the pristine value.
  _onMorphFormFocus = (e) => {
    e.target.dataset.orig = e.target.value;
  };

  _onFieldInput = (e) => {
    const filled = e.target.value !== '';
    e.target.classList.toggle('igt-field--filled', filled);
    e.target.classList.toggle('igt-field--empty', !filled);
  };

  _basicKeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = e.target.dataset.orig ?? '';
      e.target.blur();
    }
  };

  // Commit an annotation/orthography cell on blur if its value changed. Routed
  // through the op chain so it serializes with structural edits.
  _commitField(e, apply) {
    if (this.readOnly) return;
    const el = e.target;
    if (el.dataset.suppressCommit) { delete el.dataset.suppressCommit; return; }
    const next = el.value;
    if (next === (el.dataset.orig ?? '')) return;
    this._run(() => apply(next));
  }

  _field({ key, value, apply, extraClass = '', sentence = false }) {
    const filled = (value ?? '') !== '';
    return html`<input
      class="igt-field ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${sentence ? 'igt-field--sentence' : ''} ${extraClass}"
      data-cell-key=${key}
      ?disabled=${this.readOnly}
      ${uncontrolledValue(value ?? '')}
      @focus=${this._onFieldFocus}
      @input=${this._onFieldInput}
      @keydown=${this._basicKeydown}
      @blur=${(e) => this._commitField(e, apply)}
    >`;
  }

  // ---- morpheme form field (adds split/merge/delete key handling) ----
  _morphFormKeydown(morph, word, siblings) {
    return async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.target.value = e.target.dataset.orig ?? '';
        e.target.blur();
        return;
      }
      if (this.readOnly) return;
      const el = e.target;

      // Restore the optimistic DOM if a structural op was dropped/failed.
      const restore = (origValue) => {
        el.disabled = false;
        if (origValue != null) el.value = origValue;
        delete el.dataset.suppressCommit;
        this._pendingFocus = null;
        el.focus();
      };

      if (e.key === '-') {
        e.preventDefault();
        const pos = el.selectionStart ?? el.value.length;
        const left = el.value.slice(0, pos);
        const right = el.value.slice(pos);
        const orig = el.value;
        el.value = left;
        el.dataset.suppressCommit = '1';
        el.disabled = true; // block stale keystrokes during the async op
        this._pendingFocus = { wordId: word.id, precedence: (morph.precedence ?? 1) + 1, cursor: 0 };
        const ok = await this._run(() => this.doc.splitMorpheme(morph.id, left, right));
        el.disabled = false; // lit-html won't reset it (readOnly binding unchanged)
        if (!ok) restore(orig);
        return;
      }

      if (e.key === 'Backspace') {
        const atStart = (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0;
        const idx = siblings.findIndex((m) => m.id === morph.id);
        // Delete an emptied non-first morpheme.
        if (el.value.trim() === '' && idx > 0) {
          e.preventDefault();
          el.dataset.suppressCommit = '1';
          el.disabled = true;
          this._pendingFocus = { wordId: word.id, precedence: (morph.precedence ?? 1) - 1, cursor: 'end' };
          const ok = await this._run(() => this.doc.deleteMorpheme(morph.id));
          el.disabled = false;
          if (!ok) restore(null);
          return;
        }
        // Merge into the previous morpheme when cursor is at the very start.
        if (atStart && idx > 0) {
          e.preventDefault();
          const prev = siblings[idx - 1];
          const prevLen = morphFormOf(prev).length;
          el.dataset.suppressCommit = '1';
          el.disabled = true;
          this._pendingFocus = { wordId: word.id, precedence: prev.precedence ?? idx, cursor: prevLen };
          const ok = await this._run(() => this.doc.mergeMorphemes(morph.id));
          el.disabled = false;
          if (!ok) restore(null);
          return;
        }
      }
    };
  }

  _commitMorphForm(e, morphId) {
    if (this.readOnly) return;
    const el = e.target;
    if (el.dataset.suppressCommit) { delete el.dataset.suppressCommit; return; }
    const next = el.value;
    if (next === (el.dataset.orig ?? '')) return;
    this._run(() => this.doc.updateMorphemeForm(morphId, next));
  }

  // Placeholder morpheme column: create a new morpheme on commit.
  _placeholderKeydown() {
    return (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; e.target.blur(); }
    };
  }
  async _commitPlaceholder(e, word) {
    if (this.readOnly) return;
    const el = e.target;
    const form = el.value.trim();
    if (!form) { el.value = ''; return; }
    el.disabled = true;
    this._pendingFocus = { placeholderWord: word.id };
    const ok = await this._run(() => this.doc.createMorpheme(word.id, form));
    el.disabled = false;
    if (ok) {
      el.value = ''; // clear only on success
    } else {
      this._pendingFocus = null; // keep the typed form so the user can retry
      el.focus();
    }
  }

  // ---- templates ----
  _template() {
    const doc = this.doc;
    if (doc.error) {
      // surfaced inline above the grid; toasts handled at the React layer later
    }
    const info = doc.layerInfo;
    if (!info.primaryTokenLayer) {
      return html`<div class="igt-island__empty">This document has no primary token layer configured.</div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      return html`<div class="igt-island__empty">No tokens yet — tokenize the document first (Tokenize tab).</div>`;
    }

    const orthographies = (info.primaryTokenLayer.config?.plaid?.orthographies || []).map((o) => o.name);
    const wordFields = info.spanLayers.word.map((l) => l.name);
    const morphFields = info.spanLayers.morpheme.map((l) => l.name);
    const sentFields = info.spanLayers.sentence.map((l) => l.name);
    const hasMorphemes = !!info.morphemeTokenLayer;
    const ignoredCfg = info.primaryTokenLayer.config?.plaid?.ignoredTokens || null;

    const ctx = { orthographies, wordFields, morphFields, sentFields, hasMorphemes, ignoredCfg };

    return html`
      ${doc.error ? html`<div class="igt-island__error">${doc.error}</div>` : nothing}
      ${repeat(sentences, (s) => s.id, (s, i) => this._sentence(s, i, ctx))}
    `;
  }

  _sentence(sentence, index, ctx) {
    return html`
      <div class="igt-sentence">
        <span class="igt-sentence__num">${index + 1}</span>
        <div class="igt-grid">
          ${this._labels(ctx)}
          <div class="igt-tokens">
            ${repeat(sentence.tokens, (t) => t.id, (t) => this._tokenCol(t, ctx))}
          </div>
        </div>
        ${this._sentenceAnnos(sentence, ctx)}
      </div>
    `;
  }

  _labels(ctx) {
    return html`
      <div class="igt-labels">
        <div class="igt-row-label igt-row-label--spacer"></div>
        ${ctx.orthographies.map((n) => html`<div class="igt-row-label">${n}</div>`)}
        ${ctx.wordFields.map((n) => html`<div class="igt-row-label">${n}</div>`)}
        ${ctx.hasMorphemes ? html`<div class="igt-row-label igt-row-label--morph">Morphemes</div>` : nothing}
        ${ctx.hasMorphemes ? ctx.morphFields.map((n) => html`<div class="igt-row-label igt-row-label--morph">${n}</div>`) : nothing}
      </div>
    `;
  }

  _tokenCol(token, ctx) {
    const ignored = isTokenIgnored(token.content, ctx.ignoredCfg);
    return html`
      <div class="igt-token-col">
        <div class="igt-token-form" title=${token.content}>
          ${this._vocabFace(token.content, { id: token.id, vocabItem: token.vocabItem, formText: token.content, kind: 'word' })}
        </div>
        ${ctx.orthographies.map((name) => html`
          <div class="igt-cell">
            ${this._field({
              key: `or:${token.id}:${name}`,
              value: token.orthographies?.[name] ?? '',
              apply: (v) => this.doc.updateOrthography(token.id, name, v),
            })}
          </div>
        `)}
        ${ctx.wordFields.map((name) => ignored
          ? html`<div class="igt-cell igt-cell--ignored"></div>`
          : html`<div class="igt-cell">
              ${this._field({
                key: `wa:${token.id}:${name}`,
                value: token.annotations?.[name]?.value ?? '',
                apply: (v) => this.doc.updateTokenSpan(token.id, name, v),
              })}
            </div>`)}
        ${ctx.hasMorphemes ? this._morphemes(token, ctx) : nothing}
      </div>
    `;
  }

  _morphemes(token, ctx) {
    const morphemes = token.morphemes || [];
    return html`
      <div class="igt-morphemes">
        ${repeat(morphemes, (m) => m.id, (m) => this._morphCol(m, token, morphemes, ctx))}
        ${this.readOnly ? nothing : this._placeholderMorphCol(token, ctx)}
      </div>
    `;
  }

  _morphCol(morph, word, siblings, ctx) {
    const value = morphFormOf(morph);
    const filled = value !== '';
    return html`
      <div class="igt-morph-col">
        <div class="igt-morph-form">
          ${this._vocabFace(
            html`<input
              class="igt-field igt-morph-field ${filled ? 'igt-field--filled' : 'igt-field--empty'}"
              data-cell-key=${`mf:${morph.id}`}
              data-word=${word.id}
              data-prec=${morph.precedence ?? 1}
              ?disabled=${this.readOnly}
              ${uncontrolledValue(value)}
              @focus=${this._onMorphFormFocus}
              @input=${this._onFieldInput}
              @keydown=${this._morphFormKeydown(morph, word, siblings)}
              @blur=${(e) => this._commitMorphForm(e, morph.id)}
            >`,
            { id: morph.id, vocabItem: morph.vocabItem, formText: value, kind: 'morpheme' },
          )}
        </div>
        ${ctx.morphFields.map((name) => html`
          <div class="igt-morph-cell">
            ${this._field({
              key: `ma:${morph.id}:${name}`,
              value: morph.annotations?.[name]?.value ?? '',
              apply: (v) => this.doc.updateMorphemeSpan(morph.id, name, v),
              extraClass: 'igt-morph-field',
            })}
          </div>
        `)}
      </div>
    `;
  }

  _placeholderMorphCol(word, ctx) {
    return html`
      <div class="igt-morph-col igt-morph-col--placeholder">
        <div class="igt-morph-form">
          <input
            class="igt-field igt-morph-field igt-morph-field--placeholder igt-field--empty"
            data-word=${word.id}
            placeholder="+"
            @keydown=${this._placeholderKeydown()}
            @blur=${(e) => this._commitPlaceholder(e, word)}
          >
        </div>
        ${ctx.morphFields.map(() => html`<div class="igt-morph-cell"></div>`)}
      </div>
    `;
  }

  _sentenceAnnos(sentence, ctx) {
    if (!ctx.sentFields.length) return nothing;
    return html`
      <div class="igt-sentence-annos">
        ${ctx.sentFields.map((name) => html`
          <div class="igt-sentence-anno">
            <span class="igt-sentence-anno__label">${name}</span>
            ${this._field({
              key: `sa:${sentence.id}:${name}`,
              value: sentence.annotations?.[name]?.value ?? '',
              apply: (v) => this.doc.updateSentenceSpan(sentence.id, name, v),
              sentence: true,
            })}
          </div>
        `)}
      </div>
    `;
  }

  // Display a baseline form (word/morpheme) with a vocab-link affordance: the
  // linked item's form as a hint (click to manage), or a small "link" control
  // when nothing is linked. `face` may be a string or an input template.
  // opts: { id, vocabItem, formText, kind }
  _vocabFace(face, opts) {
    const { id, vocabItem, formText, kind } = opts;
    const hasVocabs = Object.keys(this.doc.vocabularies || {}).length > 0;
    const open = this._popover && this._popover.tokenId === id;
    const canLink = hasVocabs && !this.readOnly;
    const openerClick = (e) => {
      if (!canLink) return;
      e.stopPropagation();
      open ? this._closePopover() : this._openPopover(id, kind, e.currentTarget);
    };
    let opener = nothing;
    if (vocabItem) {
      opener = html`<span class="igt-vocab__opener igt-vocab__hint" title=${vocabItem.form} @click=${openerClick}>${vocabItem.form}</span>`;
    } else if (canLink) {
      opener = html`<span class="igt-vocab__opener igt-vocab__link" @click=${openerClick}>link</span>`;
    }
    return html`
      <span class="igt-vocab">
        ${face}
        ${opener}
        ${open ? this._vocabPopover(id, formText, vocabItem) : nothing}
      </span>
    `;
  }

  _vocabPopover(tokenId, formText, currentItem) {
    const vocabs = Object.values(this.doc.vocabularies || {});
    const createVocabId = vocabs[0]?.id;
    const search = (this._popoverSearch || '').toLowerCase();
    const ft = (formText || '').toLowerCase();
    let items = [];
    vocabs.forEach((v) => (v.items || []).forEach((it) => items.push({ ...it, _vocabName: v.name })));
    if (search) items = items.filter((it) => (it.form || '').toLowerCase().includes(search));
    items.sort((a, b) => levenshtein(ft, (a.form || '').toLowerCase()) - levenshtein(ft, (b.form || '').toLowerCase()));
    if (currentItem) {
      const i = items.findIndex((it) => it.id === currentItem.id);
      if (i > 0) { const [x] = items.splice(i, 1); items.unshift(x); }
    }
    const limited = items.slice(0, 30);
    const pos = this._popoverPos;
    const posStyle = pos ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;` : '';
    return html`
      <div class="igt-vocab-pop" style=${posStyle} @click=${(e) => e.stopPropagation()}>
        <input class="igt-vocab-pop__search" placeholder="Search lexicon…" autofocus
          .value=${live(this._popoverSearch || '')}
          @input=${(e) => { this._popoverSearch = e.target.value; this._render(true); }}
          @keydown=${(e) => { if (e.key === 'Escape') this._closePopover(); }}>
        <div class="igt-vocab-pop__list">
          ${limited.length
            ? limited.map((it) => {
                const linked = currentItem && it.id === currentItem.id;
                return html`<button class="igt-vocab-pop__item ${linked ? 'is-linked' : ''}"
                  @click=${(e) => { e.stopPropagation(); this._toggleVocab(tokenId, it, linked); }}>
                  <span>${it.form}</span>
                  ${vocabs.length > 1 ? html`<span class="igt-vocab-pop__vname">${it._vocabName}</span>` : nothing}
                  ${linked ? html`<span class="igt-vocab-pop__x">unlink</span>` : nothing}
                </button>`;
              })
            : html`<div class="igt-vocab-pop__empty">No matches</div>`}
        </div>
        ${createVocabId && formText
          ? html`<button class="igt-vocab-pop__create"
              @click=${(e) => { e.stopPropagation(); this._createVocab(tokenId, createVocabId, formText); }}>
              + Create "${formText}"
            </button>`
          : nothing}
      </div>
    `;
  }
}
