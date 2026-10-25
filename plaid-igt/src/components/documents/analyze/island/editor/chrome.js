import { html, svg, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { PROV, PROV_STATES, readReview } from '@larc-iu/plaid-client';
import { readOrthographies, readIgnoredTokens } from '@/domain/igtConfig';
import { translationFieldsOf } from '@/domain/sentenceRole';
import { PRECEDENT_SOURCE, VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';
import { bracketPieces } from '@/domain/mwe';
import { humanizeError } from '@/utils/feedback';
import { provConfidence, provTitle } from './shared.js';
import { keys } from '@/lib/keymap.js';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import { saveStateText } from '@ui/lib/saveState.js';
import { buttonVariants } from '@ui/components/ui/button.jsx';
import {
  RUN_BAR,
  RUN_BUTTON,
  HELP_TOGGLE,
  HELP_MARK,
  HELP_PANEL,
  RUN_COUNT,
  PAGER,
  PAGER_BUTTON,
  PAGER_LABEL,
  PAGER_FOOT,
} from '@ui/components/shared/runBar.js';
import { countOf } from '@ui/lib/plural.js';

// The grid's frame: the page template, the pager and toolbar, the legend,
// the tooltips' wording, and one sentence's block.
// An action's chord as keycaps, in whatever the person has bound it to.
const kbd = (id) => keys.caps(id).map((cap, i) => html`${i ? '+' : ''}<kbd>${cap}</kbd>`);

// lucide's Sparkles, the Auto-analyze dialog's own icon, and its spinner while
// a run is on, as ServiceRunButton draws them in ud and umr.
const ICON = (body, extra = '', size = 'h-4 w-4') =>
  html`<svg
    class="${size} ${extra}"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${body}
  </svg>`;
const SPARKLES = svg`<path
    d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
  /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />`;
const SPINNER = svg`<path d="M21 12a9 9 0 1 1-6.219-8.56" />`;
// lucide's chevrons, as RunBarPager draws its steps in ud and umr.
const FIRST = svg`<path d="m17 18-6-6 6-6" /><path d="M7 6v12" />`;
const PREV = svg`<path d="m15 18-6-6 6-6" />`;
const NEXT = svg`<path d="m9 18 6-6-6-6" />`;
const LAST = svg`<path d="m7 18 6-6-6-6" /><path d="M17 6v12" />`;

export const chrome = {
  _template() {
    const doc = this.doc;
    const info = doc.layerInfo;
    if (!info.primaryTokenLayer) {
      return html` <div class="igt-island__empty igt-island__empty--warn">
        <p>${NOT_SET_UP}</p>
      </div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      // One muted line and the app's own outline button, as every other empty
      // state draws it.
      return html` <div class="igt-island__empty">
        <p>No sentences. Split the text on the Tokenize tab.</p>
        ${this.readOnly
          ? nothing
          : html`<button
              type="button"
              class="igt-empty__cta ${buttonVariants({ variant: 'outline', size: 'sm' })}"
              @click=${(e) => {
                e.stopPropagation();
                this._navigateTab('tokenize');
              }}
            >
              Go to Tokenize
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
      translationFields: translationFieldsOf(info.spanLayers.sentence),
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
            ${humanizeError(doc.errorCause ?? doc.error, doc.error)}
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

  // A cell still focused on the page going away is taken off first, so what
  // was typed into it commits: the render removes the cell, and a browser
  // need not fire blur on a removed element. The pager's own buttons blur on
  // mousedown, a citation or a search hit landing on another page does not.
  _setPage(page, scrollToTop = false) {
    if (page === this._page) return;
    const el = document.activeElement;
    if (el && el !== document.body && this.container.contains(el)) el.blur();
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

  // plaid-ui's RunBarPager in lit-html: in the run row at the top, and the
  // same pager centred under the last sentence.
  _pager(total, pageCount, where) {
    const start = this._page * this.constructor.PAGE_SIZE;
    const end = Math.min(total, start + this.constructor.PAGE_SIZE);
    const btn = (icon, target, title, disabled) =>
      html` <button
        type="button"
        class="igt-pager__btn ${PAGER_BUTTON}"
        ?disabled=${disabled}
        title=${title}
        aria-label=${title}
        @click=${(e) => {
          e.stopPropagation();
          this._setPage(target, where === 'bottom');
        }}
      >
        ${ICON(icon, '', 'h-3.5 w-3.5')}
      </button>`;
    const pager = html`
      <div class="igt-pager ${PAGER}">
        ${btn(FIRST, 0, 'First page', this._page === 0)}
        ${btn(PREV, this._page - 1, 'Previous page', this._page === 0)}
        <span class="igt-pager__label ${PAGER_LABEL}">${start + 1}–${end} of ${total}</span>
        ${btn(NEXT, this._page + 1, 'Next page', this._page >= pageCount - 1)}
        ${btn(LAST, pageCount - 1, 'Last page', this._page >= pageCount - 1)}
      </div>
    `;
    return where === 'bottom'
      ? html`<div class="igt-pager-foot ${PAGER_FOOT}">${pager}</div>`
      : pager;
  },

  // Glossing progress: morphemes with at least one filled gloss field / total.
  // The save-status pill. It has a lit root of its own inside the static mount
  // above, so a save repaints it without re-rendering the grid (_paintStatus).
  _statusPill() {
    const state = this._statusState || 'idle';
    return html`<span class="igt-status" role="status" aria-live="polite" data-state=${state}
      >${saveStateText(state)}</span
    >`;
  },

  // The RunBar every annotation tab shares (plaid-ui's runBar.js): the run at
  // the start, the help toggle at the end, the legend under the row.
  _toolbar(sentences, ctx, pageCount = 1) {
    const nSent = sentences.length;
    const running = this._autoAnalyzeStatus?.running;
    return html`
      <div class="igt-toolbar ${RUN_BAR}">
        ${
          /* Gated on canAutoAnalyze rather than readOnly: an Auto-analyze run
              takes the document read-only, and this button is where that
              run's progress shows and how the dialog is reopened, so it must
              outlive the lock it caused. */
          this.canAutoAnalyze
            ? html`<button
                type="button"
                class="igt-toolbar__btn ${RUN_BUTTON}"
                data-running=${running ? 'true' : nothing}
                title=${running
                  ? `Auto-analyze, ${this._autoAnalyzeStatus.label}`
                  : /* A phrase, like every other button here. The steps it
                       can run are the dialog's own checkboxes. */
                    'Analyze the document automatically'}
                @click=${(e) => {
                  e.stopPropagation();
                  this._openAutoAnalyze();
                }}
              >
                ${running ? ICON(SPINNER, 'animate-spin') : ICON(SPARKLES)}
                Auto-analyze${running
                  ? html` <span class="igt-toolbar__elapsed"
                      >${this._autoAnalyzeStatus.label}</span
                    >`
                  : nothing}
              </button>`
            : nothing
        }
        ${pageCount > 1
          ? this._pager(nSent, pageCount, 'top')
          : html`<span class="igt-toolbar__count ${RUN_COUNT}"
              >${countOf(nSent, 'sentence')}</span
            >`}
        <span class="igt-status-mount ms-auto"></span>
        <button
          type="button"
          class="igt-help-btn ${HELP_TOGGLE}"
          aria-expanded=${this._helpOpen ? 'true' : 'false'}
          @click=${(e) => {
            e.stopPropagation();
            this._toggleHelp();
          }}
        >
          <span aria-hidden="true" class=${HELP_MARK}>?</span>Keys and marks
        </button>
      </div>
    `;
  },

  // The tooltip of a marked cell (see provStateText): its value and state,
  // with the two origins of a confirmed value told apart.
  _cellTitle(value, state, origin, note = null) {
    return provTitle(value, state, origin, this.doc.isContributor, note);
  },

  // A machine value's confidence against the project's threshold
  // (provConfidence).
  _confidence(metadata) {
    return provConfidence(metadata, this.doc.confidenceThreshold);
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
      return `seen ${countOf(g.count, 'time')} in this project`;
    return null;
  },

  // The tooltip of a link chip or MWE label: what it links to and, for a
  // marked link, its state and what the click does. `single` is a word's or
  // morpheme's own chip (the MWE label prefixes the words itself).
  _linkStateText(state, origin, form, canLink, single = false) {
    const manage = canLink ? ' · manage' : '';
    const linked = single ? `Linked to "${form}"` : `linked to "${form}"`;
    if (state === PROV_STATES.MACHINE)
      return `${single ? 'Auto-linked' : 'auto-linked'} to "${form}": open to accept or change`;
    if (state === PROV_STATES.CONTRIBUTED)
      return this.doc.isContributor
        ? `${linked}: contributed, awaiting review${manage}`
        : `${linked}: contributed. Open to accept or change`;
    if (state === PROV_STATES.VERIFIED)
      return `${linked}: ${origin === PROV.CONTRIBUTED ? 'contributed' : 'auto-linked'}, confirmed${manage}`;
    return `${linked}${manage}`;
  },

  _legend(ctx) {
    return html`
      <div class="igt-legend ${HELP_PANEL}">
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
            <span class="igt-legend__prov--machine igt-legend__prov--doubtful">low confidence</span>
            ·
            ${ctx.reviewsSomeone
              ? html`<span class="igt-legend__prov--contributed">contributed</span> · `
              : nothing}<span class="igt-legend__prov--verified">confirmed</span> · plain: a
            person's · ${kbd('analyze.accept')} to accept a word's proposal,
            ${kbd('analyze.discard')} to discard it, ${kbd('analyze.prevUnverified')} and
            ${kbd('analyze.nextUnverified')} to jump between them</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Suggestions</strong>
          <span
            ><span class="igt-legend__guess">from this project</span> ·
            <span class="igt-legend__guess igt-legend__guess--entry">from the linked entry</span> ·
            <kbd>↵</kbd> to accept one, ${kbd('analyze.alternatives')} to list the rest</span
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
            <kbd>↑</kbd><kbd>↓</kbd> to move between rows · <kbd>←</kbd><kbd>→</kbd> to move along
            the row from the ends of a value · <kbd>Esc</kbd> to cancel an edit ·
            <kbd>Alt</kbd>+click a word to open it in Tokenize</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Rows</strong>
          <span
            >click a row label (or <kbd>↵</kbd>/<kbd>Space</kbd> on it) to pick which rows show ·
            minimized rows stay as a thin stripe · <kbd>Esc</kbd> to close the menu</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>Morphemes</strong>
              <span
                >type <kbd>-</kbd> to split, <kbd>=</kbd> to split at a clitic (pasting
                <em>a-b=c</em> splits too) · <kbd>⌫</kbd> at the start to merge with the previous ·
                ${kbd('morph.literalHyphen')} / ${kbd('morph.literalEquals')} literal character ·
                ${kbd('morph.zero')} to type a zero morph <em>∅</em></span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>Special characters</strong>
          <span
            >type <kbd>\\</kbd> and a two-letter code in any text field: <em>\\sw</em> → ə,
            <em>\\ng</em> → ŋ, <em>\\?g</em> → ʔ, <em>\\00</em> → ∅ · these are Praat's codes ·
            <em>\\u0250</em> → any character by number · <kbd>\\</kbd><kbd>\\</kbd> for a plain
            backslash · add codes for this project under Settings → Text and vocab</span
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
    const sctx = { sentence, index, posMap, lanes, pending, pendingIdx: sel ? pendingIdx : null };
    return html`
      <div
        class="igt-sentence"
        data-sentence-id=${sentence.id}
        dir=${this.doc.textDirection}
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
          <div class="igt-sentence__toolrow" dir="ltr">
            ${this._assistantControl(sentence, index)} ${this._copyControl(sentence, ctx)}
          </div>
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
