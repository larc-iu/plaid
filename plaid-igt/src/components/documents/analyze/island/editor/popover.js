// The one popover surface: where it opens, how it is sized and moved, and
// how it closes, whatever it is showing.
export const popover = {
  //
  // The anchoring machinery below (position, re-anchor on scroll, fit after
  // render, focus return) is generic; only its SELECTORS were vocab-specific.
  // Rather than rename `.igt-vocab-pop` / `[data-vocab-opener]` — which the
  // vocab e2e specs select on — every popover root also carries `data-igt-pop`
  // and every opener also carries `data-pop-opener="<variant>:<id>"`. The
  // variant is part of the opener key because one word can have both a vocab
  // opener and a comment badge, and an id alone would re-anchor a comment
  // popover onto the vocab chip.
  _popEl() {
    return this.container.querySelector('[data-igt-pop]');
  },

  _openerEl(key) {
    return key ? this.container.querySelector(`[data-pop-opener="${key}"]`) : null;
  },

  // Focus whatever the open popover nominates, once it is in the DOM.
  // (lit-html `autofocus` is unreliable on nodes inserted by a re-render
  // rather than initial parse.)
  _focusPopover() {
    const el = this.container.querySelector('[data-pop-autofocus]');
    if (!el) return;
    try {
      el.focus();
    } catch {
      /* noop */
    }
  },

  // How wide each popover variant is, for the placement math. Must match the
  // width its CSS actually renders at.
  _popWidth(variant = this._popover?.variant) {
    return variant === 'comment' ? 320 : 240;
  },

  _openPopover(tokenId, kind, anchorEl) {
    // Replacing a comment popover with a vocab one bypasses _closePopover, so
    // give up the live-stream claim here too or it leaks.
    this._releaseCommentLive?.();
    this._releaseCommentLive = null;
    this._popover = { tokenId, kind, variant: 'vocab' };
    this._popoverSearch = '';
    this._popoverActiveIndex = null; // the render picks the best-ranked row
    this._popoverVocabId = null; // re-default to the linked item's vocab each open
    this._popoverCreateEdit = null; // string while the "+ Create" row is being edited
    clearTimeout(this._createClickTimer);
    this._createClickTimer = null;
    this._popoverReturnId = `vocab:${tokenId}`;
    this._popoverPos = this._computePopoverPos(anchorEl, undefined, this._popWidth('vocab'));
    this._ensurePrecedent();
    this._render(true);
    this._focusPopover();
  },

  // Move the highlighted popover row. `total` includes the virtual "create" row
  // when present, so ↓ past the last item lands on Create (keyboard-reachable).
  _movePopoverActive(delta, total) {
    if (total <= 0) return;
    const cur = this._popoverActiveIndex ?? 0;
    this._popoverActiveIndex = Math.max(0, Math.min(total - 1, cur + delta));
    this._render(true);
    // lit-html reuses the search node across this render, so focus is retained;
    // keep the active row visible.
    const active = this._popEl()?.querySelector('.is-active');
    if (active?.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  },

  // Keep an open popover glued to its opener while the page/grid scrolls or
  // the window resizes. Patches the fixed coords directly (no re-render per
  // frame); closes only if the opener left the DOM (e.g. a reload re-derived
  // the grid).
  _repositionPopover() {
    if (!this._popover || this._repositionRaf) return;
    this._repositionRaf = requestAnimationFrame(() => {
      this._repositionRaf = null;
      if (!this._popover) return;
      const opener = this._openerEl(this._popoverReturnId);
      const pos = opener ? this._computePopoverPos(opener, undefined, this._popWidth()) : null;
      if (!pos) {
        this._closePopover();
        return;
      }
      this._popoverPos = pos;
      const el = this._popEl();
      if (el) {
        el.style.left = `${pos.left}px`;
        el.style.top = `${pos.top}px`;
      }
    });
  },

  // Position the popover (240px wide) below the opener as fixed coords, clamped
  // to the viewport — so edge columns don't overflow and the grid's overflow-x
  // scroll container can't clip it.
  // `height`: the popover's measured height once rendered (see _fitPopover);
  // before the first paint an estimate is used.
  _computePopoverPos(anchorEl, height = 280, width = 240) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = width,
      Hest = height,
      pad = 8;
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
  },

  // returnFocus: send focus back to the opener (for keyboard-driven closes —
  // Escape / Enter-select). Mouse/scroll/outside-click closes must NOT, or they
  // would steal focus from wherever the user clicked.
  _closePopover(returnFocus = false) {
    if (!this._popover) return;
    this._releaseCommentLive?.();
    this._releaseCommentLive = null;
    const returnId = this._popoverReturnId;
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._popoverActiveIndex = 0;
    this._popoverCreateEdit = null;
    clearTimeout(this._createClickTimer);
    this._createClickTimer = null;
    this._popoverReturnId = null;
    this._render(true);
    if (returnFocus && returnId != null) {
      const opener = this._openerEl(returnId);
      if (opener) {
        try {
          opener.focus();
        } catch {
          /* noop */
        }
      }
    }
  },

  // Re-anchor the open popover with its REAL height: the estimate that placed
  // it may be short (rows, notes, the create editor all vary), which in a short
  // viewport flipped it above the word and let it cover the word itself.
  _fitPopover() {
    if (!this._popover) return;
    const el = this._popEl();
    const opener = this._openerEl(this._popoverReturnId);
    if (!el || !opener) return;
    const pos = this._computePopoverPos(opener, el.offsetHeight || undefined, this._popWidth());
    if (!pos || (pos.left === this._popoverPos?.left && pos.top === this._popoverPos?.top)) return;
    this._popoverPos = pos;
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  },

  // Browsers fire mousemove when content re-flows UNDER a stationary pointer
  // (a popover re-render, a row growing). Only a real pointer movement should
  // move the keyboard highlight, or Enter can land on a row the user never
  // hovered (TEST_PLAN finding 17).
  _pointerMoved(e) {
    const last = this._lastPointer;
    this._lastPointer = { x: e.clientX, y: e.clientY };
    return !last || last.x !== e.clientX || last.y !== e.clientY;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
