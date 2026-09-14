import { html, nothing } from 'lit-html';
import { notifyError } from '@/utils/feedback';
import { COPY_FORMATS, COPY_FORMAT_STORAGE_KEY, formatSentence } from '@/domain/igtExport';

// Copy as IGT: the format menu, the clipboard write, and a sentence's link.
export const copy = {
  // Non-mutating, so it works in read-only/historical views too. The main
  // button copies in the user's favorite format (persisted in localStorage);
  // the caret opens a format menu, and picking a format copies AND becomes
  // the new favorite.
  _favoriteCopyFormat() {
    const stored = localStorage.getItem(COPY_FORMAT_STORAGE_KEY);
    return COPY_FORMATS.some((f) => f.id === stored) ? stored : 'plain';
  },

  // The caret that opened the format menu, when focus is inside the menu:
  // closing it takes away the row the focus is on, and focus would fall to the
  // page. Read BEFORE the render that removes it, as the popover's does.
  _copyMenuAnchor() {
    const menu = this.container.querySelector('.igt-copy__menu');
    return menu?.contains(document.activeElement)
      ? (menu.closest('.igt-copy')?.querySelector('.igt-copy__caret') ?? null)
      : null;
  },

  _closeCopyMenu() {
    if (this._copyMenu == null) return;
    const back = this._copyMenuAnchor();
    this._copyMenu = null;
    this._render(true);
    if (back?.isConnected) back.focus();
  },

  async _copySentence(sentence, ctx, format) {
    // Picking a format closes the menu too, so it hands focus back the same way.
    const back = this._copyMenuAnchor();
    const fields = {
      morphFields: ctx.morphFields,
      wordFields: ctx.wordFields,
      sentFields: ctx.sentFields,
    };
    const text = formatSentence(sentence, fields, format);
    const written = await this._writeClipboard(text);
    this._copyMenu = null;
    if (!written) {
      this._render(true);
      if (back?.isConnected) back.focus();
      return;
    }
    this._copiedFlash = sentence.id;
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => {
      this._copiedFlash = null;
      this._render(true);
    }, 1400);
    this._render(true);
    if (back?.isConnected) back.focus();
  },

  /**
   * Write to the clipboard, and say whether it landed: both routes can fail
   * (a refused permission, an insecure context where execCommand is disabled
   * too), and the ✓ that follows this is a lie when they do.
   */
  async _writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API unavailable (insecure context): textarea fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
      if (!ok) notifyError('Clipboard access was refused.', 'Could not copy');
      return ok;
    }
  },

  // A shareable deep link to one sentence: the Analyze tab of this document,
  // focused on this sentence (DocumentDetail reads ?focusSentence= and the
  // island scrolls to it and flashes it — see _consumeFocusRequest).
  //
  // Built off location.origin + pathname, NOT a hard-coded root: in the packaged
  // jar the app is served under /igt/, and the routes live in the hash. Same
  // reason PlaidClient.inviteUrl takes the app URL from the caller.
  _sentenceLink(sentence) {
    const { origin, pathname } = window.location;
    const base = `${origin}${pathname}`.replace(/\/$/, '');
    const projectId = this.doc?.project?.id ?? this.doc?._projectId;
    return (
      `${base}/#/projects/${projectId}/documents/${this.doc.id}` +
      `?tab=analyze&focusSentence=${encodeURIComponent(sentence.id)}`
    );
  },

  async _copySentenceLink(sentence) {
    if (!(await this._writeClipboard(this._sentenceLink(sentence)))) return;
    this._linkFlash = sentence.id;
    clearTimeout(this._linkTimer);
    this._linkTimer = setTimeout(() => {
      this._linkFlash = null;
      this._render(true);
    }, 1400);
    this._render(true);
  },

  _copyControl(sentence, ctx) {
    const fav = this._favoriteCopyFormat();
    const favLabel = COPY_FORMATS.find((f) => f.id === fav)?.label ?? fav;
    const open = this._copyMenu === sentence.id;
    const copied = this._copiedFlash === sentence.id;
    const linked = this._linkFlash === sentence.id;
    return html`
      <div class="igt-copy" @click=${(e) => e.stopPropagation()}>
        <button
          type="button"
          class="igt-copy__link ${linked ? 'is-copied' : ''}"
          title="Copy a link to this sentence"
          aria-label="Copy a link to this sentence"
          @click=${() => this._copySentenceLink(sentence)}
        >
          ${linked
            ? html`<span class="igt-copy__linkok" aria-hidden="true">✓</span>`
            : html`<svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>`}
        </button>
        <button
          type="button"
          class="igt-copy__btn"
          title=${`Copy as IGT: ${favLabel}`}
          @click=${() => this._copySentence(sentence, ctx, fav)}
        >
          ${copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          type="button"
          class="igt-copy__caret"
          aria-label="Choose copy format"
          aria-expanded=${open ? 'true' : 'false'}
          @click=${() => {
            this._copyMenu = open ? null : sentence.id;
            this._render(true);
          }}
        >
          ▾
        </button>
        ${open
          ? html` <div class="igt-copy__menu" role="menu">
              ${COPY_FORMATS.map(
                (f) => html`
                  <button
                    type="button"
                    class="igt-copy__item ${f.id === fav ? 'is-fav' : ''}"
                    role="menuitem"
                    @click=${() => {
                      localStorage.setItem(COPY_FORMAT_STORAGE_KEY, f.id);
                      this._copySentence(sentence, ctx, f.id);
                    }}
                  >
                    <span>${f.label}</span>
                    ${f.id === fav ? html`<span class="igt-copy__fav">★</span>` : nothing}
                  </button>
                `,
              )}
              <div class="igt-copy__hint">picking a format makes it the default</div>
            </div>`
          : nothing}
      </div>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
