import { html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { provOrigin, PROV_STATES } from '@larc-iu/plaid-client';
import { isTokenIgnored } from '@/domain/igtConfig';
import { allowedGuess } from '@/domain/glossGuess';
import { morphemeJoiner } from '@/domain/affixMarkers';
import { KINDS } from '@/domain/precedent';
import {
  morphFormOf,
  numHtml,
  provClass,
  provDisplay,
  provTitle,
  uncontrolledValue,
} from './shared.js';

// The cells themselves: row labels, a word's column, its morphemes, gaps
// and inert columns, sentence annotations, and the face of a vocab chip.
export const grid = {
  _labels(ctx) {
    // Each label is truncated with an ellipsis (see .igt-row-label__text) so a
    // long field/orthography name can't spill into the token grid; the row's
    // title attr keeps the full name available on hover.
    // Clicking any label opens the row menu (minimize / expand). The whole label
    // is the hit target rather than a separate affordance: the column is narrow,
    // and a 6px minimized row has no room for an icon.
    const openMenu = (e) => this._openRowMenuFrom(e);
    const lbl = (cls, name, scope, key) => {
      const collapsed = this._isCollapsed(key);
      return html` <div
        class="igt-row-label ${cls}${this._rowCls(key)}"
        data-row=${key}
        title=${collapsed ? `${name} (${scope}) — minimized` : `${name} (${scope})`}
        role="button"
        tabindex="0"
        aria-expanded=${collapsed ? 'false' : 'true'}
        @click=${openMenu}
        @keydown=${(e) => {
          // preventDefault: Space on a div scrolls the page.
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu(e);
          }
        }}
      >
        <span class="igt-row-label__text">${name}</span>
      </div>`;
    };
    return html`
      <div class="igt-labels">
        <div class="igt-row-label igt-row-label--spacer"></div>
        ${ctx.orthographies.map((n) => lbl('igt-row-label--orth', n, 'orthography', `orth:${n}`))}
        ${ctx.wordFields.map((n) => lbl('igt-row-label--word', n, 'word', `word:${n}`))}
        ${ctx.hasMorphemes
          ? lbl(
              'igt-row-label--morph igt-row-label--morphform',
              'Morphemes',
              'morpheme',
              'morphform',
            )
          : nothing}
        ${ctx.hasMorphemes
          ? ctx.morphFields.map((n) => lbl('igt-row-label--morph', n, 'morpheme', `morph:${n}`))
          : nothing}
      </div>
    `;
  },

  // Cross-browser content sizing fallback (for browsers without CSS
  // field-sizing): the input's `size` attr tracks its value's code-point length.
  _fieldSize(v) {
    return Math.max(5, [...(v ?? '')].length + 1);
  },

  _tokenCol(token, ctx, sctx) {
    // Ignored tokens (punctuation, per the project's ignored-tokens config) are
    // real word tokens but carry no annotation — no orthographies, no gloss, no
    // lexicon link, and no morpheme is healed onto them (see igtReconcile). They
    // render like a gap: in the text, but plainly not glossed.
    if (isTokenIgnored(token.content, ctx.ignoredCfg)) {
      // Still a column a multi-word expression may run across: it draws the
      // lines' pieces, never a label.
      return this._inertCol(
        token.content,
        `${token.content}: excluded from annotation`,
        this._mweBrackets(token, sctx).rules,
      );
    }
    // Marked word tokens (a tokenizer service stamps prov on token metadata)
    // show the same violet/dashed treatment on the form band; Ctrl+Enter on
    // the word confirms the token along with its analysis.
    const wp = provDisplay(token.metadata);
    const wpTitle = wp
      ? provTitle(token.content, wp, provOrigin(token.metadata), this.doc.isContributor).replace(
          'machine-suggested',
          'machine-tokenized',
        )
      : token.content;
    // Multi-word expressions: a member of the selection (or of the MWE whose
    // popover is open) is outlined; while gathering, every word is a target.
    const selected = this._selectedWordIds().has(token.id);
    const gathering = this._canLinkMwe() && (!!this._mweSel || !!this._openMwe());
    const brackets = this._mweBrackets(token, sctx);
    return html`
      <div class="igt-token-col" data-word-col=${token.id}>
        <div
          class="igt-token-form ${provClass('igt-token-form', wp)} ${selected
            ? 'is-selected'
            : ''} ${gathering ? 'igt-token-form--selectable' : ''}"
          title=${wpTitle}
          @mousedown=${(e) => {
            // Shift+click gathers words and Alt+click leaves for Tokenize; keep
            // the browser from selecting text under either.
            if (e.shiftKey || e.altKey) e.preventDefault();
            this._rememberForTokenize(e.currentTarget);
          }}
          @click=${(e) => this._onWordFormClick(e, sctx.sentence, token)}
        >
          ${this._vocabFace(token.content, {
            id: token.id,
            vocabItem: token.vocabItem,
            formText: token.content,
            kind: 'word',
            // Anchored to the FORM, not to the cell: a column is as wide as the
            // widest morpheme beneath it, so a badge pinned to the cell's right
            // edge floats far from the word it is about.
            badge: this._commentBadge('token', token.id, token.content),
            laneRows: brackets.laneRows,
          })}
          ${brackets.rules}
        </div>
        ${ctx.orthographies.map(
          (name) => html`
            <div class="igt-cell${this._rowCls(`orth:${name}`)}" data-row=${`orth:${name}`}>
              ${this._field({
                key: `or:${token.id}:${name}`,
                value: token.orthographies?.[name] ?? '',
                apply: (v) => this.doc.updateOrthography(token.id, name, v),
                ariaLabel: `${name} for ${token.content}`,
              })}
            </div>
          `,
        )}
        ${ctx.wordFields.map(
          (name) =>
            html`<div class="igt-cell${this._rowCls(`word:${name}`)}" data-row=${`word:${name}`}>
              ${this._field({
                key: `wa:${token.id}:${name}`,
                badge: token.annotations?.[name]?.id
                  ? this._commentBadge(
                      'span',
                      token.annotations[name].id,
                      `${name} of ${token.content}`,
                    )
                  : null,
                value: token.annotations?.[name]?.value ?? '',
                apply: (v, meta) => this.doc.updateTokenSpan(token.id, name, v, meta),
                ariaLabel: `${name} for ${token.content}`,
                tagset: this._tagsetFor('word', name),
                guess: allowedGuess(
                  ctx.guess?.guessFor(
                    'word',
                    this._precedentForm(token.content, KINDS.WORD),
                    name,
                    {
                      vocabItem: token.vocabItem,
                    },
                  ) ?? null,
                  this._tagsetFor('word', name),
                ),
                alternatives: () =>
                  this._alternatives({
                    precedent: this._precedentTally(),
                    kind: KINDS.WORD,
                    form: this._precedentForm(token.content, KINDS.WORD),
                    field: name,
                    vocabItem: token.vocabItem,
                    span: token.annotations?.[name],
                    tagset: this._tagsetFor('word', name),
                  }),
                prov: provDisplay(token.annotations?.[name]?.metadata),
                provOrigin: provOrigin(token.annotations?.[name]?.metadata),
                confirmWord: token.id,
              })}
            </div>`,
        )}
        ${ctx.hasMorphemes ? this._morphemes(token, ctx) : nothing}
      </div>
    `;
  },

  // A slim, non-editable column for baseline text that carries no annotation:
  // both gaps (text no token covers) and ignored word tokens (e.g. punctuation)
  // render this way — the text in the header, nothing editable below, a
  // full-height column rule so it reads as a real grid column. Only the top
  // (word-form) band is occupied, so the gray header strip stays continuous.
  _inertCol(content, title, rules = nothing) {
    const text = (content || '').trim();
    return html`
      <div class="igt-gap-col">
        <div class="igt-gap-form" title=${title}>${text}${rules}</div>
      </div>
    `;
  },

  // A run of baseline text that no word token covers — punctuation, stray
  // characters, anything between or around tokens.
  _gapCol(piece, sctx) {
    const text = (piece.content || '').trim();
    return this._inertCol(text, `${text}: not part of any word`, this._mweGapRules(piece, sctx));
  },

  // A gap (text no word covers, such as a comma) that lies inside a
  // multi-word expression's span draws the dotted pass-through on that lane,
  // so the line reads as one line from first word to last.
  _mweGapRules(piece, sctx) {
    const tokens = sctx.sentence.tokens;
    let next = tokens.findIndex((t) => t.begin >= piece.end);
    if (next < 0) next = tokens.length;
    const rules = [];
    for (const m of sctx.sentence.mwes || []) {
      if (m.first < next && next <= m.last) rules.push(this._mweRule('pass', m.lane, m));
    }
    const pi = sctx.pendingIdx;
    if (pi && pi.length >= 2 && pi[0] < next && next <= pi[pi.length - 1]) {
      rules.push(this._mweRule('pass', sctx.lanes, null));
    }
    return rules;
  },

  _morphemes(token, ctx) {
    const morphemes = token.morphemes || [];
    // The affix joint ("-", or "=" for clitics) belongs to the BOUNDARY, not to
    // either morpheme — it renders between the columns, straddling the gap.
    return html`
      <div class="igt-morphemes">
        ${repeat(
          morphemes,
          // Keyed by POSITION in the word, not by token id. A word nobody has
          // analyzed shows a morpheme that is not stored (virtualMorpheme.js),
          // and committing into it gives it a real id. Keyed by id, lit would
          // tear the column down and rebuild it, dropping the caret out of the
          // cell the user had just moved to. Precedence is 1-based and unique
          // within a word, so it identifies the column either way.
          (m) => m.precedence,
          (m, i) => {
            const joiner = i > 0 ? morphemeJoiner(morphemes[i - 1]?.morphType, m.morphType) : null;
            return html`
              ${joiner
                ? html`<span class="igt-morph-joiner" aria-hidden="true">${joiner}</span>`
                : nothing}
              ${this._morphCol(m, token, morphemes, ctx)}
            `;
          },
        )}
      </div>
    `;
  },

  _morphCol(morph, word, siblings, ctx) {
    const value = morphFormOf(morph);
    const filled = value !== '';
    // Chips linked to a stem/root lexicon entry keep the lavender accent —
    // a coverage cue for lexical identification; everything else stays quiet.
    // Machine-made segmentation (copied analyses) marks the morpheme TOKEN's
    // metadata; the form cell carries the unverified/verified styling.
    const prov = provDisplay(morph.metadata);
    return html`
      <div class="igt-morph-col">
        <div class="igt-morph-form ${this._rowCls('morphform')}" data-row="morphform">
          ${this._vocabFace(
            html`<input
              class="igt-field igt-morph-field ${filled
                ? 'igt-field--filled'
                : 'igt-field--empty'} ${provClass('igt-field', prov)}"
              data-cell-key=${`mf:${morph.id}`}
              data-word=${word.id}
              data-prec=${morph.precedence ?? 1}
              data-confirm-word=${word.id}
              aria-label=${`Morpheme form${value ? ` ${value}` : ''}`}
              title=${prov
                ? this._cellTitle(value, prov, provOrigin(morph.metadata))
                : filled
                  ? value
                  : nothing}
              size=${this._fieldSize(value)}
              spellcheck="false"
              ?disabled=${this.readOnly}
              ${uncontrolledValue(value)}
              @focus=${this._onMorphFormFocus}
              @input=${this._onFieldInput}
              @keydown=${this._morphFormKeydown(morph, word, siblings)}
              @paste=${this._onMorphPaste(morph, word)}
              @blur=${(e) => this._commitMorphForm(e, morph.id)}
            />`,
            {
              id: morph.id,
              vocabItem: morph.vocabItem,
              formText: value,
              kind: 'morpheme',
              badge: this._commentBadge('token', morph.id, value || 'morpheme'),
            },
          )}
        </div>
        ${ctx.morphFields.map(
          (name) => html`
            <div class="igt-morph-cell${this._rowCls(`morph:${name}`)}" data-row=${`morph:${name}`}>
              ${this._field({
                key: `ma:${morph.id}:${name}`,
                badge: morph.annotations?.[name]?.id
                  ? this._commentBadge(
                      'span',
                      morph.annotations[name].id,
                      `${name} of ${value || 'morpheme'}`,
                    )
                  : null,
                value: morph.annotations?.[name]?.value ?? '',
                apply: (v, meta) => this.doc.updateMorphemeSpan(morph.id, name, v, meta),
                extraClass: 'igt-morph-field',
                ariaLabel: `${name} for morpheme${value ? ` ${value}` : ''}`,
                tagset: this._tagsetFor('morpheme', name),
                guess: allowedGuess(
                  ctx.guess?.guessFor('morpheme', value, name, { vocabItem: morph.vocabItem }) ??
                    null,
                  this._tagsetFor('morpheme', name),
                ),
                alternatives: () =>
                  this._alternatives({
                    precedent: this._precedentTally(),
                    kind: KINDS.MORPHEME,
                    form: value,
                    field: name,
                    vocabItem: morph.vocabItem,
                    span: morph.annotations?.[name],
                    tagset: this._tagsetFor('morpheme', name),
                  }),
                prov: provDisplay(morph.annotations?.[name]?.metadata),
                provOrigin: provOrigin(morph.annotations?.[name]?.metadata),
                confirmWord: word.id,
              })}
            </div>
          `,
        )}
      </div>
    `;
  },

  // Sentence-scoped fields, under the grid. They minimize from the same row menu
  // as the grid rows, and their label is the same kind of opener. Unlike a grid
  // row, a minimized one drops its field entirely rather than keeping an empty
  // box: nothing down here has to stay in lockstep with the token columns.
  _sentenceAnnos(sentence, index, ctx) {
    if (!ctx.sentFields.length) return nothing;
    return html`
      <div class="igt-sentence-annos">
        ${ctx.sentFields.map((name) => {
          const key = `sent:${name}`;
          const collapsed = this._isCollapsed(key);
          return html`
            <div class="igt-sentence-anno${this._rowCls(key)}">
              <span
                class="igt-sentence-anno__label"
                data-row=${key}
                title=${collapsed ? `${name} (sentence) — minimized` : `${name} (sentence)`}
                role="button"
                tabindex="0"
                aria-expanded=${collapsed ? 'false' : 'true'}
                @click=${(e) => this._openRowMenuFrom(e)}
                @keydown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._openRowMenuFrom(e);
                  }
                }}
              >
                <span class="igt-sentence-anno__text">${name}</span>
              </span>
              ${collapsed
                ? nothing
                : html`
                    ${this._field({
                      key: `sa:${sentence.id}:${name}`,
                      value: sentence.annotations?.[name]?.value ?? '',
                      apply: (v) => this.doc.updateSentenceSpan(sentence.id, name, v),
                      sentence: true,
                      ariaLabel: `${name} for sentence ${index + 1}`,
                      tagset: this._tagsetFor('sentence', name),
                      // Only worth building for a governed field: an ungoverned
                      // sentence field is free prose with no list to offer.
                      alternatives: this._tagsetFor('sentence', name)
                        ? () =>
                            this._alternatives({
                              precedent: this._precedentTally(),
                              kind: KINDS.WORD,
                              form: null,
                              field: name,
                              span: sentence.annotations?.[name],
                              tagset: this._tagsetFor('sentence', name),
                            })
                        : null,
                      prov: provDisplay(sentence.annotations?.[name]?.metadata),
                      provOrigin: provOrigin(sentence.annotations?.[name]?.metadata),
                      confirmSentence: sentence.id,
                      fieldName: name,
                    })}
                    ${sentence.annotations?.[name]?.id
                      ? this._commentBadge(
                          'span',
                          sentence.annotations[name].id,
                          `${name} of sentence ${index + 1}`,
                          { inline: true },
                        )
                      : nothing}
                  `}
            </div>
          `;
        })}
      </div>
    `;
  },

  // Display a baseline form (word/morpheme) with a vocab-link affordance: the
  // linked item's form as a chip (click to manage), or a "link" control when
  // nothing is linked (hidden at rest, revealed on column hover / keyboard
  // focus — see .igt-vocab__link in the CSS). Both are real <button>s so
  // they're keyboard-focusable and operable (Enter/Space). `face` may be a
  // string or an input template. opts: { id, vocabItem, formText, kind }
  _vocabFace(face, opts) {
    const { id, vocabItem, formText, kind } = opts;
    const hasVocabs = Object.keys(this.doc.vocabularies || {}).length > 0;
    // Variant matters, not just the id: a comment popover on a WORD stores
    // that word's token id too, so matching on the id alone opened the lexicon
    // menu underneath the comment thread.
    const open = this._popover?.variant === 'vocab' && this._popover.tokenId === id;
    const canLink = hasVocabs && !this.readOnly;
    const openerClick = (e) => {
      e.stopPropagation();
      open ? this._closePopover() : this._openPopover(id, kind, e.currentTarget);
    };
    let opener = nothing;
    if (vocabItem) {
      // Machine-unverified violet, contributed amber, and everything settled
      // renders plain. derive.js always sets vocabItem.prov (and provOrigin).
      //
      // CONFIRMED links look exactly like hand-made ones on purpose. They used
      // to carry a violet dotted underline saying "a machine made this and a
      // person confirmed it", which was imperceptible at 10px without zooming
      // in, and marking it harder would have been worse: across the corpora
      // there are 216,318 confirmed links against 68 made by hand, so the mark
      // was on 97% of everything and distinguished nothing. What is left
      // violet at rest is only what still wants review, which is what violet
      // is for and is legible precisely because it is rare. The origin is
      // still in the data, in queries, and in this button's own tooltip.
      //
      // Cells are the OPPOSITE and keep their mark (.igt-field--verified):
      // 476 confirmed against 1,897,067 typed by hand, so there it is the
      // exception it looks like.
      const state = vocabItem.prov;
      const settled = state === PROV_STATES.HUMAN || state === PROV_STATES.VERIFIED;
      const stateClass = provClass('igt-vocab__hint', settled ? null : state);
      const title = this._linkStateText(state, vocabItem.provOrigin, vocabItem.form, canLink, true);
      const sub = this._itemNumber(vocabItem);
      opener = html`<button
        type="button"
        class="igt-vocab__opener igt-vocab__hint ${stateClass}"
        data-vocab-opener=${id}
        data-pop-opener=${`vocab:${id}`}
        ?disabled=${!canLink}
        title=${title}
        @click=${openerClick}
      >
        ${vocabItem.form}${numHtml(sub, 'igt-vocab')}
      </button>`;
    } else if (canLink) {
      opener = html`<button
        type="button"
        class="igt-vocab__opener igt-vocab__link"
        data-vocab-opener=${id}
        data-pop-opener=${`vocab:${id}`}
        title="Link to a lexicon entry"
        @click=${openerClick}
      >
        link
      </button>`;
    }
    // A word's stack holds, between the word and its chip, one row per lane
    // of multi-word expressions (the sentence sets how many); the first
    // member's row carries the label, the lines themselves lie over the
    // column (see _mweBrackets).
    return html`
      <span class="igt-vocab">
        <span class="igt-vocab__face">${face}${opts.badge ?? nothing}</span>
        ${kind === 'word'
          ? html`<span class="igt-vocab__mwe-lanes">${opts.laneRows ?? nothing}</span>`
          : nothing}
        ${opener} ${open ? this._vocabPopover(id, formText, vocabItem, kind) : nothing}
      </span>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
