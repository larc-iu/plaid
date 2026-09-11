import { html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { PROV, PROV_STATES, readReview } from '@larc-iu/plaid-client';
import { readOrthographies, readIgnoredTokens } from '@/domain/igtConfig';
import { PRECEDENT_SOURCE, VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';
import { bracketPieces } from '@/domain/mwe';
import { humanizeError } from '@/utils/feedback';
import { provTitle } from './shared.js';

// The grid's frame: the page template, the pager and toolbar, the legend,
// the tooltips' wording, and one sentence's block.
export const chrome = {
  _template() {
    const doc = this.doc;
    if (doc.error) {
      // surfaced inline above the grid; toasts handled at the React layer later
    }
    const info = doc.layerInfo;
    if (!info.primaryTokenLayer) {
      return html` <div class="igt-island__empty igt-island__empty--warn">
        <div class="igt-empty__title">This document isn't set up for interlinear analysis yet</div>
        <p class="igt-empty__body">
          No primary <em>word</em> token layer is configured for this project. An administrator
          needs to finish project setup before the interlinear grid can be used.
        </p>
      </div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      return html` <div class="igt-island__empty">
        <div class="igt-empty__title">Nothing to analyze yet</div>
        <p class="igt-empty__body">
          Interlinear glossing happens here once the text is split into words. Head to the
          <strong>Tokenize</strong> tab to break the baseline text into sentences and words first.
        </p>
        ${this.readOnly
          ? nothing
          : html`<button
              type="button"
              class="igt-empty__cta"
              @click=${(e) => {
                e.stopPropagation();
                this._navigateTab('tokenize');
              }}
            >
              Go to Tokenize →
            </button>`}
      </div>`;
    }

    const orthographies = (readOrthographies(info.primaryTokenLayer.config) || []).map(
      (o) => o.name,
    );
    const wordFields = info.spanLayers.word.map((l) => l.name);
    const morphFields = info.spanLayers.morpheme.map((l) => l.name);
    const sentFields = info.spanLayers.sentence.map((l) => l.name);
    const hasMorphemes = !!info.morphemeTokenLayer;
    const ignoredCfg = readIgnoredTokens(info.primaryTokenLayer.config);
    this._ignoredCfg = ignoredCfg; // the popover trims a new entry's form by it

    // Gloss guesses (pluggable — see domain/glossGuess.js; assign
    // this.guessSourceFactory to swap the algorithm). They read project
    // precedent, fetched once per document (re-rendering when it lands);
    // null in read-only mode so historical views never show suggestions.
    if (!this.readOnly) this._ensurePrecedent();
    const guess = this.readOnly ? null : this._guessSource(sentences, wordFields, morphFields);

    const ctx = {
      orthographies,
      wordFields,
      morphFields,
      sentFields,
      hasMorphemes,
      ignoredCfg,
      guess,
      // The legend explains the contributed mark only where it can appear:
      // when the project reviews anyone's work.
      reviewsSomeone: (({ users, roles }) => users.length > 0 || roles.length > 0)(
        readReview(this.doc.project?.config),
      ),
    };
    // _computeRowMenuPos needs the row list to estimate the menu's height, and
    // it runs from a click handler rather than from render.
    this._lastCtx = ctx;

    // One page of sentences in the DOM (see PAGE_SIZE). Sentence numbering
    // stays GLOBAL; cross-page movement is handled by the pager and the search
    // click-through (_consumeFocusRequest pages first).
    const pageCount = Math.max(1, Math.ceil(sentences.length / this.constructor.PAGE_SIZE));
    this._page = Math.min(Math.max(0, this._page), pageCount - 1);
    const pageStart = this._page * this.constructor.PAGE_SIZE;
    const pageSentences = sentences.slice(pageStart, pageStart + this.constructor.PAGE_SIZE);

    return html`
      ${this._toolbar(sentences, ctx, pageCount)} ${this._helpOpen ? this._legend(ctx) : nothing}
      ${doc.error
        ? html`<div class="igt-island__error" role="alert">
            ${humanizeError(doc.error, doc.error)}
          </div>`
        : nothing}
      ${repeat(
        pageSentences,
        (s) => s.id,
        (s, i) => this._sentence(s, pageStart + i, ctx),
      )}
      ${pageCount > 1 ? this._pager(sentences.length, pageCount, 'bottom') : nothing}
      ${this._rowMenu ? this._rowMenuPanel(ctx) : nothing}
    `;
  },

  _setPage(page, scrollToTop = false) {
    if (page === this._page) return;
    this._page = page;
    this._render(true);
    if (scrollToTop) {
      try {
        this.container.scrollIntoView({ block: 'start' });
      } catch {
        /* noop */
      }
    }
  },

  _pager(total, pageCount, where) {
    const start = this._page * this.constructor.PAGE_SIZE;
    const end = Math.min(total, start + this.constructor.PAGE_SIZE);
    const btn = (label, target, title, disabled) =>
      html` <button
        type="button"
        class="igt-pager__btn"
        ?disabled=${disabled}
        title=${title}
        @click=${(e) => {
          e.stopPropagation();
          this._setPage(target, where === 'bottom');
        }}
      >
        ${label}
      </button>`;
    return html`
      <div class="igt-pager">
        ${btn('«', 0, 'First page', this._page === 0)}
        ${btn('‹', this._page - 1, 'Previous page', this._page === 0)}
        <span class="igt-pager__label">${start + 1}–${end} of ${total}</span>
        ${btn('›', this._page + 1, 'Next page', this._page >= pageCount - 1)}
        ${btn('»', pageCount - 1, 'Last page', this._page >= pageCount - 1)}
      </div>
    `;
  },

  // Glossing progress: morphemes with at least one filled gloss field / total.
  _toolbar(sentences, ctx, pageCount = 1) {
    const nSent = sentences.length;
    return html`
      <div class="igt-toolbar">
        <div class="igt-toolbar__left">
          ${pageCount > 1
            ? this._pager(nSent, pageCount, 'top')
            : html`<span class="igt-toolbar__count"
                >${nSent} sentence${nSent === 1 ? '' : 's'}</span
              >`}
          ${
            /* Gated on canAutoAnalyze rather than readOnly: an Auto-analyze run
                takes the document read-only, and this button is where that
                run's progress shows and how the dialog is reopened, so it must
                outlive the lock it caused. */
            this.canAutoAnalyze
              ? html`<button
                  type="button"
                  class="igt-toolbar__btn"
                  data-running=${this._autoAnalyzeStatus?.running ? 'true' : nothing}
                  title=${this._autoAnalyzeStatus?.running
                    ? `Auto-analyze, ${this._autoAnalyzeStatus.label}`
                    : 'Analyze the document automatically: copy previous analyses, have a service propose segmentation and glosses, and link to the lexicon. Proposals show in violet until you confirm them.'}
                  @click=${(e) => {
                    e.stopPropagation();
                    this._openAutoAnalyze();
                  }}
                >
                  Auto-analyze${this._autoAnalyzeStatus?.running
                    ? html` <span class="igt-toolbar__elapsed"
                        >${this._autoAnalyzeStatus.label}</span
                      >`
                    : nothing}
                </button>`
              : nothing
          }
        </div>
        <div class="igt-toolbar__right">
          <span
            class="igt-status"
            role="status"
            aria-live="polite"
            data-state=${this._statusState || 'idle'}
          ></span>
          <button
            type="button"
            class="igt-help-btn"
            aria-expanded=${this._helpOpen ? 'true' : 'false'}
            aria-label="Keyboard & scope help"
            title="Keyboard & scope help"
            @click=${(e) => {
              e.stopPropagation();
              this._toggleHelp();
            }}
          >
            ?
          </button>
        </div>
      </div>
    `;
  },

  // The tooltip of a marked cell (see provStateText): its value and state,
  // with the two origins of a confirmed value told apart.
  _cellTitle(value, state, origin) {
    return provTitle(value, state, origin, this.doc.isContributor);
  },

  // What a suggestion is standing on, so a person can weigh it before pressing
  // Enter: the entry it came from (and whether that link is confirmed), or how
  // often the project has already said this for the same form.
  _guessBasis(g) {
    if (g.source === VOCAB_ENTRY_SOURCE) {
      const entry = g.entryForm ? `the entry “${g.entryForm}”` : 'the linked entry';
      return g.trusted ? `from ${entry}` : `from ${entry}, unconfirmed link`;
    }
    if (g.source === PRECEDENT_SOURCE && g.count)
      return `seen ${g.count} time${g.count === 1 ? '' : 's'} in this project`;
    return null;
  },

  // The tooltip of a link chip or MWE label: what it links to and, for a
  // marked link, its state and what the click does. `single` is a word's or
  // morpheme's own chip (the MWE label prefixes the words itself).
  _linkStateText(state, origin, form, canLink, single = false) {
    const manage = canLink ? ' · manage' : '';
    const linked = single ? `Linked to "${form}"` : `linked to "${form}"`;
    if (state === PROV_STATES.MACHINE)
      return `${single ? 'Auto-linked' : 'auto-linked'} to "${form}": open to confirm or change`;
    if (state === PROV_STATES.CONTRIBUTED)
      return this.doc.isContributor
        ? `${linked}: contributed, awaiting review${manage}`
        : `${linked}: contributed. Open to confirm or change`;
    if (state === PROV_STATES.VERIFIED)
      return `${linked}: ${origin === PROV.CONTRIBUTED ? 'contributed' : 'auto-linked'}, confirmed${manage}`;
    return `${linked}${manage}`;
  },

  _legend(ctx) {
    return html`
      <div class="igt-legend">
        <div class="igt-legend__row">
          <strong>Scopes</strong>
          <span class="igt-legend__chip igt-legend__chip--orth">Orthography</span>
          <span class="igt-legend__chip igt-legend__chip--word">Word</span>
          ${ctx.hasMorphemes
            ? html`<span class="igt-legend__chip igt-legend__chip--morph">Morpheme</span>`
            : nothing}
          <span class="igt-legend__chip igt-legend__chip--sent">Sentence</span>
        </div>
        <div class="igt-legend__row">
          <strong>Marks</strong>
          <span
            ><span class="igt-legend__prov--machine">machine-made</span> ·
            ${ctx.reviewsSomeone
              ? html`<span class="igt-legend__prov--contributed">contributed</span> · `
              : nothing}<span class="igt-legend__prov--verified">confirmed</span> · plain: a
            person's · <kbd>Ctrl</kbd>+<kbd>↵</kbd> accepts a word's proposal, <kbd>Ctrl</kbd>+<kbd
              >⌫</kbd
            >
            discards it, <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>↑</kbd><kbd>↓</kbd> jumps between
            them</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Suggestions</strong>
          <span
            ><span class="igt-legend__guess">from this project</span> ·
            <span class="igt-legend__guess igt-legend__guess--entry">from the linked entry</span> ·
            <kbd>↵</kbd> accepts one, <kbd>Alt</kbd>+<kbd>↓</kbd> lists the rest</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>Lexicon</strong>
              <span
                >the form under a morpheme is the entry it is linked to, and nothing under it means
                no link · click it to manage the link</span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>Navigate</strong>
          <span
            ><kbd>Enter</kbd>/<kbd>Tab</kbd> next cell in the same row · <kbd>⇧</kbd>+ previous ·
            <kbd>↑</kbd><kbd>↓</kbd> move rows · <kbd>←</kbd><kbd>→</kbd> move along the row from
            the ends of a value · <kbd>Esc</kbd> cancel edit · <kbd>Alt</kbd>+click a word to open
            it in Tokenize</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Rows</strong>
          <span
            >click a row label (or <kbd>↵</kbd>/<kbd>Space</kbd> on it) to pick which rows show ·
            minimized rows stay as a thin stripe · <kbd>Esc</kbd> closes the menu</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>Morphemes</strong>
              <span
                >type <kbd>-</kbd> to split, <kbd>=</kbd> to split at a clitic (pasting
                <em>a-b=c</em> splits too) · <kbd>⌫</kbd> at start merges with previous ·
                <kbd>Alt</kbd>+<kbd>-</kbd> / <kbd>Alt</kbd>+<kbd>=</kbd> literal character ·
                <kbd>Alt</kbd>+<kbd>0</kbd> types a zero morph <em>∅</em></span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>Special characters</strong>
          <span
            >type <kbd>\\</kbd> and a two-letter code in any text field: <em>\\sw</em> → ə,
            <em>\\ng</em> → ŋ, <em>\\?g</em> → ʔ, <em>\\00</em> → ∅ · these are Praat's codes ·
            <em>\\u0250</em> → any character by number · <kbd>\\</kbd><kbd>\\</kbd> for a plain
            backslash · add codes for this project under Settings → Text and Vocab</span
          >
        </div>
      </div>
    `;
  },

  _toggleHelp() {
    this._helpOpen = !this._helpOpen;
    this._render(true);
  },

  // Ask the React shell (DocumentDetail) to switch the active editor tab. The
  // island is framework-agnostic, so this goes out as a DOM CustomEvent the
  // shell listens for, rather than calling a router directly.
  _navigateTab(tab) {
    window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: { tab } }));
  },

  _sentence(sentence, index, ctx) {
    // Render word columns interleaved with the baseline text that no word token
    // covers (punctuation, stray characters): each such run gets a slim,
    // non-editable "gap" column so it stays visible in its true position.
    // Whitespace-only gaps (ordinary inter-word spacing) are dropped.
    const cols = sentence.pieces.filter((p) => p.isToken || (p.content || '').trim() !== '');
    // Multi-word expressions: the word band grows one line per lane of
    // brackets, and one more while words are being gathered in this sentence
    // (the pending bracket, drawn from the selection rather than the data).
    const lanes = sentence.mweLanes || 0;
    const posMap = this.doc.tokenPositionMaps.get(sentence.id);
    const sel = this._mweSel?.sentenceId === sentence.id ? this._mweSel : null;
    let pending = null;
    let pendingIdx = null;
    if (sel) {
      pendingIdx = [...sel.tokenIds]
        .map((id) => posMap.get(id))
        .filter((i) => i != null)
        .sort((a, b) => a - b);
      pending =
        pendingIdx.length >= 2
          ? bracketPieces(sentence.tokens.length, pendingIdx)
          : sentence.tokens.map((t, i) => (i === pendingIdx[0] ? 'solo' : null));
    }
    const sctx = { sentence, posMap, lanes, pending, pendingIdx: sel ? pendingIdx : null };
    return html`
      <div
        class="igt-sentence"
        data-sentence-id=${sentence.id}
        style=${`--igt-mwe-lanes:${lanes + (sel ? 1 : 0)}`}
        role="group"
        aria-label=${`Sentence ${index + 1}`}
      >
        <h3 class="igt-sr-only">Sentence ${index + 1}</h3>
        <span class="igt-sentence__num">
          <span aria-hidden="true">${index + 1}</span>
          ${this._commentBadge('token', sentence.id, `sentence ${index + 1}`)}
        </span>
        <div class="igt-sentence__tools">
          ${this._assistantControl(sentence, index)} ${this._copyControl(sentence, ctx)}
        </div>
        <div class="igt-grid">
          <div class="igt-tokens">
            ${this._labels(ctx)}
            ${repeat(
              cols,
              (p) => (p.isToken ? p.id : `gap:${p.begin}-${p.end}`),
              (p) => (p.isToken ? this._tokenCol(p, ctx, sctx) : this._gapCol(p, sctx)),
            )}
          </div>
        </div>
        ${this._sentenceAnnos(sentence, index, ctx)}
      </div>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
