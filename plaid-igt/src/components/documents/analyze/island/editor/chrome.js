import { html, svg, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { PROV, PROV_STATES, reviewsAnyone } from '@larc-iu/plaid-client';
import { readOrthographies, readIgnoredTokens } from '@/domain/igtConfig';
import { translationFieldsOf } from '@/domain/sentenceRole';
import { PRECEDENT_SOURCE, VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';
import { bracketPieces } from '@/domain/mwe';
import { humanizeError } from '@/utils/feedback';
import { provConfidence, provTitle, tlit } from './shared.js';
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
import { t } from '@ui/lib/i18n.js';

// The grid's frame: the page template, the pager and toolbar, the legend,
// the tooltips' wording, and one sentence's block.
// An action's chord as keycaps, in whatever the person has bound it to.
const kbd = (id) => keys.caps(id).map((cap, i) => html`${i ? '+' : ''}<kbd>${cap}</kbd>`);
// A key's cap by its name, which is the key's and stays as it is.
const cap = (name) => html`<kbd>${name}</kbd>`;

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
    // Not set up is a plain fact: the muted empty state, never a warm one.
    if (!info.primaryTokenLayer) {
      return html` <div class="igt-island__empty">
        <p>${t(NOT_SET_UP)}</p>
      </div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      // One muted line and the app's own outline button, as every other empty
      // state draws it. A document with no text is sent to Baseline (H16-6).
      const [line, tab, label] = /[^\s\u0085]/u.test(doc.body ?? '')
        ? [t('No sentences. Split the text on the Tokenize tab.'), 'tokenize', t('Go to Tokenize')]
        : [t('No text. Add it on the Baseline tab.'), 'baseline', t('Go to Baseline')];
      return html` <div class="igt-island__empty">
        <p>${line}</p>
        ${this.readOnly
          ? nothing
          : html`<button
              type="button"
              class="igt-empty__cta ${buttonVariants({ variant: 'outline', size: 'sm' })}"
              @click=${(e) => {
                e.stopPropagation();
                this._navigateTab(tab);
              }}
            >
              ${label}
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
      reviewsSomeone: reviewsAnyone(this.doc.project?.config),
    };
    // _computeRowMenuPos needs the row list to estimate the menu's height, and
    // it runs from a click handler rather than from render.
    this._lastCtx = ctx;

    // One page of sentences in the DOM (see PAGE_SIZE). Sentence numbering
    // stays GLOBAL; cross-page movement is handled by the pager and the search
    // click-through (_consumeFocusRequest pages first).
    const pageCount = Math.max(1, Math.ceil(sentences.length / this.constructor.PAGE_SIZE));
    const clamped = Math.min(Math.max(0, this._page), pageCount - 1);
    // A page past the end (a link, or deletes that took pages away) shows the
    // last, and the URL is told so in place: it never names a page not shown.
    if (clamped !== this._page) {
      this._page = clamped;
      this._tell(clamped, { replace: true });
    }
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
  //
  // `tell: false` is a turn the page around asked for (its URL changed), which
  // it need not be told about.
  _setPage(page, scrollToTop = false, { replace = false, tell = true } = {}) {
    if (page === this._page) return;
    const el = document.activeElement;
    if (el && el !== document.body && this.container.contains(el)) el.blur();
    this._page = page;
    if (tell) this._tell(page, { replace });
    this._render(true);
    if (scrollToTop) {
      try {
        this.container.scrollIntoView({ block: 'start' });
      } catch {
        /* noop */
      }
    }
  },

  // Tell the page around the island the page shown, kept until its echo
  // comes back (setPage).
  _tell(page, opts) {
    if (!this.onPageChange) return;
    this._told.push(page);
    this.onPageChange(page, opts);
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
        ${btn(FIRST, 0, t('First page'), this._page === 0)}
        ${btn(PREV, this._page - 1, t('Previous page'), this._page === 0)}
        <span class="igt-pager__label ${PAGER_LABEL}"
          >${t('{start}–{end} of {total}', { start: start + 1, end, total })}</span
        >
        ${btn(NEXT, this._page + 1, t('Next page'), this._page >= pageCount - 1)}
        ${btn(LAST, pageCount - 1, t('Last page'), this._page >= pageCount - 1)}
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
    const running = this._autoAnalyzeRunning;
    return html`
      <div class="igt-toolbar ${RUN_BAR}">
        ${
          /* Gated on canAutoAnalyze rather than readOnly: an Auto-analyze run
              takes the document read-only, and this button turns while it
              runs, so it must outlive the lock it caused. */
          this.canAutoAnalyze
            ? html`<button
                type="button"
                class="igt-toolbar__btn ${RUN_BUTTON}"
                aria-busy=${running ? 'true' : nothing}
                ?disabled=${running}
                title=${
                  /* A phrase, like every other button here. The steps it can
                     run are the dialog's own checkboxes. */
                  t('Analyze the document automatically')
                }
                @click=${(e) => {
                  e.stopPropagation();
                  this._openAutoAnalyze();
                }}
              >
                ${running ? ICON(SPINNER, 'animate-spin') : ICON(SPARKLES)} ${t('Auto-analyze')}
              </button>`
            : nothing
        }
        ${pageCount > 1
          ? this._pager(nSent, pageCount, 'top')
          : html`<span class="igt-toolbar__count ${RUN_COUNT}"
              >${t('{n, plural, one {# sentence} other {# sentences}}', { n: nSent })}</span
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
          <span aria-hidden="true" class=${HELP_MARK}>?</span>${t('Keys and marks')}
        </button>
      </div>
    `;
  },

  // The tooltip of a marked cell (see provStateText): its value and state,
  // with the two origins of a confirmed value told apart.
  _cellTitle(value, state, origin, note = null, accepts = undefined) {
    return provTitle(value, state, origin, this.doc.isContributor, note, this.readOnly, accepts);
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
      const name = g.entryId
        ? this._entryLabel({ id: g.entryId, form: g.entryForm }, g.vocabId)
        : g.entryForm;
      if (name) {
        return g.trusted
          ? t('from the entry “{name}”', { name })
          : t('from the entry “{name}”, unconfirmed link', { name });
      }
      return g.trusted ? t('from the linked entry') : t('from the linked entry, unconfirmed link');
    }
    if (g.source === PRECEDENT_SOURCE && g.count)
      return t('seen {n, plural, one {# time} other {# times}} in this project', { n: g.count });
    return null;
  },

  // The tooltip of a link chip or MWE label: what it links to and, for a
  // marked link, its state and what the click does. `single` is a word's or
  // morpheme's own chip (the MWE label prefixes the words itself). Without
  // `canLink` the chip does not open (a reader, a History version), so the
  // text names the state and no action. `words` is an MWE label's words, which
  // the text then starts with.
  _linkStateText(state, origin, form, canLink, single = false, words = null) {
    const v = {
      form,
      words,
      mwe: !single && words != null ? 'yes' : 'no',
      manage: canLink ? 'yes' : 'no',
    };
    if (state === PROV_STATES.MACHINE) {
      return canLink
        ? t(
            '{mwe, select, yes {“{words}” auto-linked} other {Auto-linked}} to "{form}": open to accept or change',
            v,
          )
        : t(
            '{mwe, select, yes {“{words}” auto-linked} other {Auto-linked}} to "{form}", unconfirmed',
            v,
          );
    }
    if (state === PROV_STATES.CONTRIBUTED) {
      if (this.doc.isContributor) {
        return t(
          '{mwe, select, yes {“{words}” linked} other {Linked}} to "{form}": contributed, awaiting review{manage, select, yes { · manage} other {}}',
          v,
        );
      }
      return canLink
        ? t(
            '{mwe, select, yes {“{words}” linked} other {Linked}} to "{form}": contributed. Open to accept or change',
            v,
          )
        : t(
            '{mwe, select, yes {“{words}” linked} other {Linked}} to "{form}": contributed, unconfirmed',
            v,
          );
    }
    if (state === PROV_STATES.VERIFIED) {
      return t(
        '{mwe, select, yes {“{words}” linked} other {Linked}} to "{form}": {origin, select, contributed {contributed} other {auto-linked}}, confirmed{manage, select, yes { · manage} other {}}',
        { ...v, origin: origin === PROV.CONTRIBUTED ? 'contributed' : 'machine' },
      );
    }
    return t(
      '{mwe, select, yes {“{words}” linked} other {Linked}} to "{form}"{manage, select, yes { · manage} other {}}',
      v,
    );
  },

  _legend(ctx) {
    const enter = cap('↵');
    const esc = cap('Esc'); // i18n-ignore: a key's name
    return html`
      <div class="igt-legend ${HELP_PANEL}">
        <div class="igt-legend__row">
          <strong>${t('Scopes')}</strong>
          <span class="igt-legend__chip igt-legend__chip--orth">${t('Orthography')}</span>
          <span class="igt-legend__chip igt-legend__chip--word">${t('Word')}</span>
          ${ctx.hasMorphemes
            ? html`<span class="igt-legend__chip igt-legend__chip--morph">${t('Morpheme')}</span>`
            : nothing}
          <span class="igt-legend__chip igt-legend__chip--sent">${t('Sentence')}</span>
        </div>
        <div class="igt-legend__row">
          <strong>${t('Marks')}</strong>
          <span
            ><span class="igt-legend__prov--machine">${t('machine-made')}</span> ·
            <span class="igt-legend__prov--machine igt-legend__prov--doubtful"
              >${t('low confidence')}</span
            >
            ·
            ${ctx.reviewsSomeone
              ? html`<span class="igt-legend__prov--contributed">${t('contributed')}</span> · `
              : nothing}<span class="igt-legend__prov--verified">${t('confirmed')}</span> ·
            ${t("plain: a person's")} ·
            ${tlit(
              {
                accept: kbd('analyze.accept'),
                discard: kbd('analyze.discard'),
                prev: kbd('analyze.prevUnverified'),
                next: kbd('analyze.nextUnverified'),
              },
              (m) =>
                t(
                  "{accept} to accept a word's proposal, {discard} to discard it, {prev} and {next} to jump between them",
                  m,
                ),
            )}</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>${t('Suggestions')}</strong>
          <span
            ><span class="igt-legend__guess">${t('from this project')}</span> ·
            <span class="igt-legend__guess igt-legend__guess--entry"
              >${t('from the linked entry')}</span
            >
            ·
            ${tlit(
              {
                enter,
                key: kbd('analyze.alternatives'),
              },
              (m) => t('{enter} to accept one, {key} to list the rest', m),
            )}</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>${t('Lexicon')}</strong>
              <span
                >${t(
                  'the form under a morpheme is the entry it is linked to, and nothing under it means no link',
                )}
                · ${t('click it to manage the link')}</span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>${t('Navigate')}</strong>
          <span
            >${tlit(
              {
                enter: cap('Enter'), // i18n-ignore: a key's name
                tab: cap('Tab'), // i18n-ignore: a key's name
              },
              (m) => t('{enter}/{tab} next cell in the same row', m),
            )}
            · ${tlit({ shift: cap('⇧') }, (m) => t('{shift}+ previous', m))} ·
            ${tlit({ keys: [cap('↑'), cap('↓')] }, (m) => t('{keys} to move between rows', m))} ·
            ${tlit(
              {
                keys: [cap('←'), cap('→')],
              },
              (m) => t('{keys} to move along the row from the ends of a value', m),
            )}
            · ${tlit({ esc }, (m) => t('{esc} to cancel an edit', m))} ·
            ${tlit(
              {
                alt: cap('Alt'), // i18n-ignore: a key's name
              },
              (m) => t('{alt}+click a word to open it in Tokenize', m),
            )}</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>${t('Spelling')}</strong>
          <span
            >${tlit({ key: kbd('analyze.respell') }, (m) => t('{key} on a word to respell it', m))}
            · ${tlit({ enter }, (m) => t('{enter} to save', m))} ·
            ${tlit({ esc }, (m) => t('{esc} to cancel', m))}</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>${t('Rows')}</strong>
          <span
            >${tlit(
              {
                enter,
                space: cap('Space'), // i18n-ignore: a key's name
              },
              (m) => t('click a row label (or {enter}/{space} on it) to pick which rows show', m),
            )}
            · ${t('minimized rows stay as a thin stripe')} ·
            ${tlit({ esc }, (m) => t('{esc} to close the menu', m))}</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>${t('Morphemes')}</strong>
              <span
                >${tlit(
                  { hyphen: cap('-'), equals: cap('='), example: html`<em>a-b=c</em>` },
                  (m) =>
                    t(
                      'type {hyphen} to split, {equals} to split at a clitic (pasting {example} splits too)',
                      m,
                    ),
                )}
                ·
                ${tlit(
                  {
                    backspace: cap('⌫'),
                  },
                  (m) => t('{backspace} at the start to merge with the previous', m),
                )}
                ·
                ${tlit(
                  {
                    hyphen: kbd('morph.literalHyphen'),
                    equals: kbd('morph.literalEquals'),
                  },
                  (m) => t('{hyphen} / {equals} literal character', m),
                )}
                ·
                ${tlit(
                  {
                    key: kbd('morph.zero'),
                    zero: html`<em>∅</em>`,
                  },
                  (m) => t('{key} to type a zero morph {zero}', m),
                )}</span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>${t('Special characters')}</strong>
          <span
            >${tlit(
              {
                backslash: cap('\\'),
                sw: html`<em>\\sw</em>`, // i18n-ignore: one of Praat's codes
                ng: html`<em>\\ng</em>`, // i18n-ignore: one of Praat's codes
                glottal: html`<em>\\?g</em>`,
                zero: html`<em>\\00</em>`,
              },
              (m) =>
                t(
                  'type {backslash} and a two-letter code in any text field: {sw} → ə, {ng} → ŋ, {glottal} → ʔ, {zero} → ∅',
                  m,
                ),
            )}
            · ${t("these are Praat's codes")} ·
            ${tlit(
              {
                example: html`<em>\\u0250</em>`,
              },
              (m) => t('{example} → any character by number', m),
            )}
            ·
            ${tlit(
              {
                backslashes: [cap('\\'), cap('\\')],
              },
              (m) => t('{backslashes} for a plain backslash', m),
            )}
            · ${t('add codes for this project under Settings → Text and vocab')}</span
          >
        </div>
      </div>
    `;
  },

  _toggleHelp() {
    this._helpOpen = !this._helpOpen;
    this._render(true);
  },

  // Ask the React shell to switch the active editor tab. The island is
  // framework-agnostic, so it calls the `onNavigateTab` its mount handed it
  // (AnalyzeIsland, the document's goToTab) rather than a router.
  _navigateTab(tab) {
    this.onNavigateTab?.(tab);
  },

  _sentence(sentence, index, ctx) {
    // Render word columns interleaved with the baseline text that no word token
    // covers (punctuation, stray characters): each such run gets a slim,
    // non-editable "gap" column so it stays visible in its true position.
    // Whitespace-only gaps (ordinary inter-word spacing) are dropped.
    const cols = sentence.pieces.filter((p) => p.isToken || (p.content || '').trim() !== '');
    // A word and the uncovered text after it wrap as one, so a sentence's
    // full stop never wraps into a band of its own (RP-3). Text before the
    // first word goes with that word.
    const units = [];
    let lead = [];
    for (const p of cols) {
      if (p.isToken) {
        units.push({ token: p, before: lead, after: [] });
        lead = [];
      } else if (units.length) units.at(-1).after.push(p);
      else lead.push(p);
    }
    if (lead.length) units.push({ token: null, before: lead, after: [] });
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
          : sentence.tokens.map((_tok, i) => (i === pendingIdx[0] ? 'solo' : null));
    }
    const sctx = { sentence, index, posMap, lanes, pending, pendingIdx: sel ? pendingIdx : null };
    return html`
      <div
        class="igt-sentence"
        data-sentence-id=${sentence.id}
        dir=${this.doc.textDirection}
        style=${`--igt-mwe-lanes:${lanes + (sel ? 1 : 0)}`}
        role="group"
        aria-label=${t('Sentence {n}', { n: index + 1 })}
      >
        <h3 class="igt-sr-only">${t('Sentence {n}', { n: index + 1 })}</h3>
        <span class="igt-sentence__num">
          <span aria-hidden="true">${index + 1}</span>
          ${this._commentBadge('token', sentence.id, t('sentence {n}', { n: index + 1 }))}
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
              units,
              (u) => (u.token ? u.token.id : `gap:${u.before[0].begin}-${u.before[0].end}`),
              (u) => {
                const gaps = (list) => list.map((p) => this._gapCol(p, sctx));
                if (!u.token) return gaps(u.before);
                const col = this._tokenCol(u.token, ctx, sctx);
                if (!u.before.length && !u.after.length) return col;
                return html`<div class="igt-col-group">
                  ${gaps(u.before)}${col}${gaps(u.after)}
                </div>`;
              },
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
