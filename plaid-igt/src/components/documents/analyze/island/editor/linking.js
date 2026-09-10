import { notifyInfo } from '@/utils/feedback';
import { sameFormUnlinked } from '@/domain/linkEverywhere.js';

// Linking a token to a lexicon entry: confirm, toggle, create, link every
// other unlinked form like it, and the hand-off to Auto-analyze.
export const linking = {
  // The toolbar button opens the React AutoAnalyzeDialog (rendered by the
  // AnalyzeIsland shell): copy previous analyses → an `analyze` service
  // proposes segmentation + glosses → link to the lexicon (built-in rule or a
  // link-vocab service) — the same service-selection idiom as the
  // Media/Tokenize tabs. The island only dispatches the open request; results
  // land via the shared doc's reload.
  _openAutoAnalyze() {
    window.dispatchEvent(new CustomEvent('igt:auto-analyze-open'));
  },

  // Run a doc mutation with a focus target to re-affirm after the render it
  // causes (a popover action re-renders the opener/chip node, so a synchronous
  // focus return is lost; E2: focus never lost). A mutation that turns out to
  // be a no-op — a confirm on a link a second click already confirmed —
  // renders nothing, and a target left waiting would be honored by the next
  // unrelated render, wherever focus was by then. So a target its own
  // mutation did not consume is dropped once that mutation settles.
  _runThenFocus(target, fn) {
    this._pendingFocus = target;
    return this._run(fn).then((result) => {
      if (this._pendingFocus === target) this._pendingFocus = null;
      return result;
    });
  },

  // "Link every ‹roa› in this text": the popover's row for the other unlinked
  // tokens reading the same as the one just linked. A row, never a default:
  // FLEx links them all on every link, which the first real user called
  // mightily annoying. Only tokens with no link of their own are taken.
  _linkEverywhere(tokenId, kind, formText, currentItem, returnFocus = false) {
    const ids = sameFormUnlinked(this.doc.sentences, kind, formText, tokenId);
    if (!ids.length || !currentItem) return;
    this._closePopover(returnFocus);
    this._runThenFocus({ vocabOpener: tokenId }, () =>
      this.doc.linkVocabMany(ids, currentItem.id),
    ).then((ok) => {
      if (ok) {
        notifyInfo(
          `Linked ${ids.length} more “${formText}” to ${currentItem.form}`,
          'Linked in this text',
        );
      }
    });
  },

  _confirmLink(tokenId, returnFocus = false) {
    this._closePopover(returnFocus);
    this._pulseLink(tokenId);
    this._runThenFocus({ vocabOpener: tokenId }, () => this.doc.confirmVocabLink(tokenId));
  },

  // (The old _suggestMorphemeGloss "copy a gloss on link" write is gone: the
  // gloss-guess system shows the same suggestion as a placeholder in the cell
  // itself, and only writes it — with provenance — when the user confirms.)
  async _toggleVocab(tokenId, item, isLinked, returnFocus = false) {
    this._closePopover(returnFocus);
    await this._runThenFocus({ vocabOpener: tokenId }, () =>
      isLinked ? this.doc.unlinkVocab(tokenId) : this.doc.linkVocab(tokenId, item.id),
    );
  },

  // Turn the "+ Create" row into an inline editor prefilled with `form`
  // (selected, so typing replaces): single click / Enter edit first, a second
  // Enter creates. Double-click creates immediately without the editor.
  _openCreateEdit(form) {
    this._popoverCreateEdit = form ?? '';
    this._render(true);
    const input = this.container.querySelector('.igt-vocab-pop__create-input');
    if (input) {
      try {
        input.focus();
        input.select();
      } catch {
        /* noop */
      }
    }
  },

  _cancelCreateEdit() {
    this._popoverCreateEdit = null;
    this._render(true);
    const search = this.container.querySelector('.igt-vocab-pop__search');
    if (search) {
      try {
        search.focus();
      } catch {
        /* noop */
      }
    }
  },

  async _createVocab(tokenId, vocabId, form, returnFocus = false) {
    this._closePopover(returnFocus);
    if (!form) return;
    await this._runThenFocus({ vocabOpener: tokenId }, () =>
      this.doc.createAndLinkVocabItem(tokenId, vocabId, form),
    );
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
