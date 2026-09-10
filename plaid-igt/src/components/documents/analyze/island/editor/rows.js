import { html } from 'lit-html';

// Minimized rows: which annotation rows are collapsed, remembered per
// project, and the row menu that toggles them.
export const rows = {
  // A row is identified by scope+name (matching the field key convention in
  // igtConfig), so renaming a field retires its old preference rather than
  // silently minimizing an unrelated new one.
  _rowStorageKey() {
    return `plaid_igt_collapsed_rows:${this.doc?.project?.id ?? 'unknown'}`;
  },

  _loadCollapsedRows() {
    try {
      const raw = localStorage.getItem(this._rowStorageKey());
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      // Private mode / blocked storage: minimizing still works for this
      // session, it just will not be remembered.
      return new Set();
    }
  },

  _saveCollapsedRows() {
    try {
      localStorage.setItem(this._rowStorageKey(), JSON.stringify([...this._collapsedRows]));
    } catch {
      /* storage unavailable — keep the in-session state */
    }
  },

  // Every minimizable row, in the order it appears on screen: the grid rows
  // first, then the sentence-scoped fields that sit under the grid. The
  // word-form row is deliberately absent — the word forms ARE the text, and
  // hiding them would leave the columns with nothing to align against.
  _rows(ctx) {
    const rows = [
      ...ctx.orthographies.map((name) => ({ key: `orth:${name}`, name, scope: 'orthography' })),
      ...ctx.wordFields.map((name) => ({ key: `word:${name}`, name, scope: 'word' })),
    ];
    if (ctx.hasMorphemes) {
      rows.push({ key: 'morphform', name: 'Morphemes', scope: 'morpheme' });
      rows.push(
        ...ctx.morphFields.map((name) => ({ key: `morph:${name}`, name, scope: 'morpheme' })),
      );
    }
    rows.push(...ctx.sentFields.map((name) => ({ key: `sent:${name}`, name, scope: 'sentence' })));
    return rows;
  },

  _isCollapsed(key) {
    return this._collapsedRows.has(key);
  },

  // Class suffix shared by a row's label and all of its cells.
  _rowCls(key) {
    return this._isCollapsed(key) ? ' is-row-collapsed' : '';
  },

  _toggleRow(key) {
    if (this._collapsedRows.has(key)) this._collapsedRows.delete(key);
    else this._collapsedRows.add(key);
    this._saveCollapsedRows();
    this._render(true);
  },

  _setAllRows(ctx, collapsed) {
    this._collapsedRows = collapsed ? new Set(this._rows(ctx).map((r) => r.key)) : new Set();
    this._saveCollapsedRows();
    this._render(true);
  },

  _closeRowMenu() {
    if (!this._rowMenu) return;
    this._rowMenu = null;
    this._rowMenuAnchor = null;
    this._render(true);
  },

  // Open the row menu under the label that was clicked (grid label or sentence
  // label — both are openers). Clicking the SAME label again closes; clicking a
  // different one moves the menu there rather than making you close and reopen.
  _openRowMenuFrom(e) {
    e.stopPropagation();
    const anchor = e.currentTarget;
    if (this._rowMenu && this._rowMenuAnchor === anchor) {
      this._rowMenu = null;
      this._rowMenuAnchor = null;
    } else {
      this._rowMenu = this._computeRowMenuPos(anchor);
      this._rowMenuAnchor = anchor;
    }
    this._render(true);
  },

  // Keep the menu glued to its label while the page or grid scrolls, the same
  // way _repositionPopover does for the vocab popover. Patches the fixed coords
  // directly rather than re-rendering per frame; closes only if the label left
  // the DOM (a reload re-derived the grid, or the page changed).
  _repositionRowMenu() {
    if (!this._rowMenu) return;
    const anchor = this._rowMenuAnchor;
    if (!anchor || !anchor.isConnected) {
      this._closeRowMenu();
      return;
    }
    const pos = this._computeRowMenuPos(anchor);
    if (!pos) return;
    this._rowMenu = pos;
    const el = this.container.querySelector('.igt-rowmenu');
    if (el) {
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
    }
  },

  // Viewport coords under the clicked label, clamped into view. `position:
  // fixed` is not a nicety here: .igt-grid sets overflow-x:auto (which forces
  // overflow-y to a clipping value), so an absolutely-positioned menu inside
  // the label column gets cut off at the bottom of the sentence band. Same
  // reason and same approach as _computePopoverPos.
  _computeRowMenuPos(anchorEl) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = 232;
    const Hest = Math.min(
      360,
      92 +
        this._rows(
          this._lastCtx ?? { orthographies: [], wordFields: [], morphFields: [], sentFields: [] },
        ).length *
          26,
    );
    const pad = 8;
    let left = Math.max(pad, Math.min(r.left, window.innerWidth - W - pad));
    let top = r.bottom + 4;
    if (top + Hest > window.innerHeight) {
      const above = r.top - Hest - 4;
      top = above > pad ? above : Math.max(pad, window.innerHeight - Hest - pad);
    }
    return { left, top };
  },

  _rowMenuPanel(ctx) {
    const rows = this._rows(ctx);
    const anyCollapsed = rows.some((r) => this._isCollapsed(r.key));
    const pos = this._rowMenu;
    const posStyle = pos ? `left:${pos.left}px;top:${pos.top}px;` : '';
    return html`
      <div class="igt-rowmenu" style=${posStyle} role="menu" @click=${(e) => e.stopPropagation()}>
        <div class="igt-rowmenu__head">
          <span>Rows</span>
          <button
            type="button"
            class="igt-rowmenu__all"
            @click=${() => this._setAllRows(ctx, !anyCollapsed)}
          >
            ${anyCollapsed ? 'Expand all' : 'Minimize all'}
          </button>
        </div>
        ${rows.map((r) => {
          const collapsed = this._isCollapsed(r.key);
          return html`
            <label class="igt-rowmenu__item" title=${`${r.name} (${r.scope})`}>
              <input
                type="checkbox"
                .checked=${!collapsed}
                @change=${() => this._toggleRow(r.key)}
              />
              <span class="igt-rowmenu__name">${r.name}</span>
              <span class="igt-rowmenu__scope">${r.scope}</span>
            </label>
          `;
        })}
        <div class="igt-rowmenu__hint">minimized rows stay as a thin stripe</div>
      </div>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
