import { html, nothing } from 'lit-html';
import { RESPELL_UNCHANGED, respellRefusal } from '@/domain/respell.js';
import { keys } from '@/lib/keymap.js';

// Respell one word in place (R51): the word's popover's Respell row, or the
// respell key on any of the word's cells and chips, opens a small box over the
// word holding its text, selected. Enter saves, Escape and leaving the box
// cancel. A plain click on a word never opens it. The write is the document's
// `respellWord`, shown at once. Not offered while the grid is read-only (a
// reader, or a past state).
export const respell = {
  // The word whose box is open: { tokenId, old, error, returnTo }, or null.
  _respellOf(tokenId) {
    return this._respell?.tokenId === tokenId ? this._respell : null;
  },

  _canRespell(tokenId) {
    if (this.readOnly) return false;
    const word = this.doc.tokenLookup?.get(tokenId);
    return !!word && (this.doc.sentences || []).some((s) => s.tokens?.includes(word));
  },

  _openRespell(tokenId) {
    if (!this._canRespell(tokenId)) return false;
    const word = this.doc.tokenLookup.get(tokenId);
    const active = document.activeElement;
    this._resetPopover();
    this._respell = {
      tokenId,
      old: word.content,
      error: null,
      // Focus goes back where it came from, or to the word's chip when it
      // came from the popover.
      returnTo:
        this.container.contains(active) && !active.closest('[data-igt-pop]') ? active : null,
    };
    this._render(true);
    const box = this._respellBox();
    if (box) {
      box.value = word.content;
      try {
        box.focus();
        box.select();
      } catch {
        /* noop */
      }
    }
    return true;
  },

  _respellBox() {
    return this.container.querySelector('.igt-respell__box');
  },

  _closeRespell() {
    const open = this._respell;
    if (!open) return;
    this._respell = null;
    this._render(true);
    const back =
      (open.returnTo?.isConnected && open.returnTo) ||
      this._openerEl(`vocab:${open.tokenId}`) ||
      this.container.querySelector(`[data-word-col="${open.tokenId}"] .igt-field`);
    try {
      back?.focus({ preventScroll: true });
    } catch {
      /* noop */
    }
  },

  // Enter: refused in the box with its reason, or the box closed and the
  // word respelled. The same spelling sends nothing.
  _commitRespell() {
    const open = this._respell;
    const box = this._respellBox();
    if (!open || !box) return;
    const typed = box.value;
    const refusal = respellRefusal(open.old, typed);
    if (refusal && refusal !== RESPELL_UNCHANGED) {
      open.error = refusal;
      this._render(true);
      return;
    }
    this._closeRespell();
    if (refusal === RESPELL_UNCHANGED) return;
    this.doc.respellWord(open.tokenId, typed);
  },

  _respellKeydown(e) {
    // The grid's own keys stay out of the box.
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this._commitRespell();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._closeRespell();
    } else if (this._respell?.error) {
      this._respell.error = null;
      this._render(true);
    }
  },

  // The box, in place of the word's face while it is open.
  _respellFace(token) {
    const open = this._respellOf(token.id);
    if (!open) return null;
    const stop = (e) => e.stopPropagation();
    return html`<span class="igt-respell" @click=${stop} @mousedown=${stop}>
      <input
        class="igt-respell__box"
        type="text"
        dir="auto"
        spellcheck="false"
        autocomplete="off"
        aria-label=${`Respell ${open.old}`}
        aria-invalid=${open.error ? 'true' : 'false'}
        title="Enter to save, Esc to cancel"
        size=${Math.max(4, [...open.old].length + 2)}
        @keydown=${(e) => this._respellKeydown(e)}
        @blur=${() => {
          if (this._respell === open) this._closeRespell();
        }}
      />${open.error
        ? html`<span class="igt-respell__note" role="alert">${open.error}</span>`
        : nothing}
    </span>`;
  },

  // The respell key, from anywhere in a word's column.
  _respellKey(e) {
    if (!keys.is('analyze.respell', e)) return false;
    const wordId = document.activeElement?.closest?.('[data-word-col]')?.dataset.wordCol;
    if (!wordId || !this._canRespell(wordId)) return false;
    e.preventDefault();
    // A cell being edited saves on the way out, as on any move.
    this._openRespell(wordId);
    return true;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
