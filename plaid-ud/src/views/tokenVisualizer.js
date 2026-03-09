function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _tempIdCounter = 0;
function tempId() { return `__temp_${++_tempIdCounter}`; }

/**
 * Render token visualizer into container.
 * Matches the old React TokenVisualizer: interlinear display with inline Tailwind styling.
 * @param {HTMLElement} container
 * @param {{ doc: import('../model/UDDocument.js').UDDocument, client: any, onUpdate: () => void }} opts
 * @returns {{ destroy: () => void, render: () => void }}
 */
export function tokenVisualizer(container, { doc, client, onUpdate }) {
  let hoveredToken = null;
  let editingToken = null;
  let editBegin = '';
  let editEnd = '';
  let hoverTimeout = null;
  let closeTimeout = null;
  let activeTooltipEl = null;
  let activeEditModalEl = null;

  // MWT drag state
  let isDragging = false;
  let dragStartToken = null;
  let dragOverIds = new Set();
  let suppressTextSelection = false;

  // ── Optimistic state overlay ─────────────────────────────────
  // Each key maps token/span IDs to local mutations that haven't been confirmed yet.
  // render() merges these on top of doc.layerInfo.
  let pendingTokenUpdates = new Map();   // tokenId → { begin, end }
  let pendingTokenAdds = [];             // [{ id (temp), begin, end }]
  let pendingTokenDeletes = new Set();   // tokenId
  let pendingSentenceAdds = new Set();   // tokenId
  let pendingSentenceDeletes = new Set();// tokenId
  let pendingMwtAdds = [];              // [{ tokenIds: [...] }]
  let pendingMwtDeletes = new Set();    // spanId

  function clearPending() {
    pendingTokenUpdates = new Map();
    pendingTokenAdds = [];
    pendingTokenDeletes = new Set();
    pendingSentenceAdds = new Set();
    pendingSentenceDeletes = new Set();
    pendingMwtAdds = [];
    pendingMwtDeletes = new Set();
  }

  /** Build a merged view of tokens/sentences/mwts for rendering. */
  function getEffectiveState() {
    const info = doc.layerInfo;
    const text = doc.textBody;

    // Tokens: start from server state, apply overlay
    let tokens = [...(info.tokenLayer?.tokens ?? [])];

    // Apply deletes
    if (pendingTokenDeletes.size > 0) {
      tokens = tokens.filter(t => !pendingTokenDeletes.has(t.id));
    }

    // Apply updates
    for (const [id, patch] of pendingTokenUpdates) {
      const idx = tokens.findIndex(t => t.id === id);
      if (idx !== -1) tokens[idx] = { ...tokens[idx], ...patch };
    }

    // Apply adds
    for (const added of pendingTokenAdds) {
      tokens.push(added);
    }

    const sorted = [...tokens].sort((a, b) => a.begin - b.begin);

    // Sentence starts
    const sentenceStarts = new Set();
    if (info.sentenceLayer) {
      for (const span of info.sentenceLayer.spans) {
        const firstTok = span.tokens?.[0];
        if (firstTok != null && !pendingSentenceDeletes.has(firstTok)) {
          sentenceStarts.add(firstTok);
        }
      }
    }
    for (const tid of pendingSentenceAdds) sentenceStarts.add(tid);

    // MWT map
    const mwtMap = new Map();
    if (info.mwtLayer) {
      for (const span of info.mwtLayer.spans) {
        if (pendingMwtDeletes.has(span.id)) continue;
        if (span.tokens) {
          for (const tid of span.tokens) {
            mwtMap.set(tid, { spanId: span.id, form: span.value, tokenIds: span.tokens });
          }
        }
      }
    }
    // Pending MWT adds (use temp IDs)
    for (const mwt of pendingMwtAdds) {
      for (const tid of mwt.tokenIds) {
        mwtMap.set(tid, { spanId: mwt.id, form: null, tokenIds: mwt.tokenIds });
      }
    }

    return { tokens: sorted, sentenceStarts, mwtMap, text, info };
  }

  /** Fire API call in background; on completion (success or fail), reload server state and re-render. */
  function backgroundSync(apiCall) {
    apiCall().then(
      async () => {
        await doc.reload();
        clearPending();
        render();
        onUpdate();
      },
      async (err) => {
        console.error('API call failed, reverting optimistic update:', err);
        await doc.reload();
        clearPending();
        render();
        onUpdate();
      }
    );
  }

  // ── Sentence toggle ──────────────────────────────────────────
  function toggleSentence(tokenId) {
    const { sentenceStarts, info } = getEffectiveState();
    if (!info.sentenceLayer) return;
    const isSent = sentenceStarts.has(tokenId);

    // Optimistic update
    if (!isSent) {
      pendingSentenceAdds.add(tokenId);
      pendingSentenceDeletes.delete(tokenId);
    } else {
      pendingSentenceDeletes.add(tokenId);
      pendingSentenceAdds.delete(tokenId);
    }
    clearHoverState();
    render();

    // Background API call
    if (!isSent) {
      backgroundSync(() => client.spans.create(info.sentenceLayer.id, [tokenId], ''));
    } else {
      const span = info.sentenceLayer.spans.find(s => s.tokens?.[0] === tokenId);
      if (span) {
        backgroundSync(() => client.spans.delete(span.id));
      }
    }
  }

  function clearHoverState() {
    hoveredToken = null;
    editingToken = null;
    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
    dismissTooltip();
    dismissEditModal();
  }

  // ── Tooltip ──────────────────────────────────────────────────
  function dismissTooltip() {
    if (activeTooltipEl) { activeTooltipEl.remove(); activeTooltipEl = null; }
  }

  function dismissEditModal() {
    if (activeEditModalEl) { activeEditModalEl.remove(); activeEditModalEl = null; }
  }

  function showTooltip(anchorEl, token, isSentStart, mwtInfo) {
    dismissTooltip();
    dismissEditModal();

    const text = doc.textBody;
    const tokenText = text.slice(token.begin, token.end);

    const tip = document.createElement('div');
    tip.className = 'absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-gray-800 text-white text-sm px-3 py-2 rounded shadow-lg whitespace-nowrap min-w-48';
    tip.style.zIndex = '50';

    let html = `<div class="mb-2">
      <div class="font-semibold">Token ${esc(String(token.id))}</div>
      <div class="text-gray-300">Range: [${token.begin}-${token.end}]</div>
      <div class="text-gray-300">Text: "${esc(tokenText)}"</div>`;
    if (mwtInfo) {
      html += `<div class="text-orange-300 mt-1">Part of MWT</div>`;
    }
    html += `</div>`;

    // Sentence toggle
    html += `<div class="mb-2 pb-2 border-b border-gray-600">
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" ${isSentStart ? 'checked' : ''} data-action="sent-toggle"
          class="rounded border-gray-400 text-blue-600 focus:ring-blue-500" />
        <span class="text-gray-300 text-xs">Start of sentence</span>
      </label>
    </div>`;

    // Buttons
    html += `<div class="flex gap-2">
      <button data-action="edit-range" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded transition-colors">Edit Range</button>
      <button data-action="delete" class="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 rounded transition-colors">Delete</button>
    </div>`;

    tip.innerHTML = html;

    // Prevent all clicks inside tooltip from bubbling to the token span
    tip.addEventListener('click', (e) => e.stopPropagation());
    tip.addEventListener('mousedown', (e) => e.stopPropagation());

    // Keep tooltip alive on hover
    tip.addEventListener('mouseenter', () => {
      if (closeTimeout) { clearTimeout(closeTimeout); closeTimeout = null; }
    });
    tip.addEventListener('mouseleave', () => {
      hoveredToken = null;
      closeTimeout = setTimeout(() => {
        if (!hoveredToken || hoveredToken.id !== token.id) {
          dismissTooltip();
        }
      }, 300);
    });

    // Sentence toggle handler
    tip.querySelector('[data-action="sent-toggle"]').addEventListener('change', (e) => {
      e.stopPropagation();
      toggleSentence(token.id);
    });

    // Button handlers
    tip.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'delete') {
        // Optimistic delete
        pendingTokenDeletes.add(token.id);
        clearHoverState();
        render();
        onUpdate();
        backgroundSync(() => client.tokens.delete(token.id));
      }

      if (action === 'edit-range') {
        dismissTooltip();
        showEditModal(anchorEl, token);
      }
    });

    anchorEl.style.position = 'relative';
    anchorEl.appendChild(tip);
    activeTooltipEl = tip;
  }

  // ── Edit Modal ───────────────────────────────────────────────
  function showEditModal(anchorEl, token) {
    dismissEditModal();
    editingToken = token;
    editBegin = String(token.begin);
    editEnd = String(token.end);

    const text = doc.textBody;
    const modal = document.createElement('div');
    modal.className = 'absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-white border border-gray-300 shadow-lg rounded-lg p-4 min-w-64';
    modal.style.zIndex = '50';

    const tokenText = text.slice(token.begin, token.end);

    modal.innerHTML = `<div class="mb-3">
        <div class="font-semibold text-gray-900 mb-1">Edit Token Range</div>
        <div class="text-sm text-gray-600">Token: "${esc(tokenText)}"</div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs font-medium text-gray-700 mb-1">Begin</label>
          <input type="number" data-field="begin" value="${token.begin}"
            class="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            min="0" max="${text.length}" />
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-700 mb-1">End</label>
          <input type="number" data-field="end" value="${token.end}"
            class="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            min="1" max="${text.length}" />
        </div>
      </div>
      <div class="flex gap-2">
        <button data-action="save" class="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 rounded transition-colors">Save</button>
        <button data-action="cancel" class="flex-1 bg-gray-600 hover:bg-gray-700 text-white text-xs px-3 py-1 rounded transition-colors">Cancel</button>
      </div>`;

    const beginInput = modal.querySelector('[data-field="begin"]');
    const endInput = modal.querySelector('[data-field="end"]');

    beginInput.addEventListener('input', () => { editBegin = beginInput.value; });
    endInput.addEventListener('input', () => { editEnd = endInput.value; });

    // Prevent clicks inside modal from toggling sentence
    modal.addEventListener('click', (e) => e.stopPropagation());
    modal.addEventListener('mousedown', (e) => e.stopPropagation());

    modal.querySelector('[data-action="save"]').addEventListener('click', () => {
      const b = parseInt(editBegin);
      const e2 = parseInt(editEnd);
      if (isNaN(b) || isNaN(e2) || b < 0 || e2 > text.length || e2 < b) return;

      // Optimistic update
      pendingTokenUpdates.set(token.id, { begin: b, end: e2 });
      clearHoverState();
      render();
      onUpdate();
      backgroundSync(() => client.tokens.update(token.id, b, e2));
    });

    modal.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      clearHoverState();
    });

    anchorEl.style.position = 'relative';
    anchorEl.appendChild(modal);
    activeEditModalEl = modal;
  }

  // ── Token element factory ────────────────────────────────────
  function makeTokenEl(token, isSentStart, mwtInfo, mwtPosition) {
    const text = doc.textBody;
    const isZeroWidth = token.begin === token.end;
    const isTemp = typeof token.id === 'string' && token.id.startsWith('__temp_');
    const displayText = isZeroWidth ? '\u2205' : text.slice(token.begin, token.end);

    const span = document.createElement('span');
    span.dataset.tokenId = token.id;

    // Build class list
    let cls = 'relative inline-block px-1 py-0.5 border cursor-pointer transition-colors whitespace-pre';

    if (mwtInfo) {
      cls += ' bg-orange-100 border-orange-400 hover:bg-orange-200';
      if (mwtPosition === 'first') cls += ' rounded-l -mr-px';
      else if (mwtPosition === 'last') cls += ' rounded-r -ml-px';
      else if (mwtPosition === 'middle') cls += ' -mx-px';
    } else {
      cls += ' bg-blue-100 border-blue-300 hover:bg-blue-200 rounded mx-0.5';
    }

    if (isSentStart) cls += ' border-green-500 border-2';
    if (dragOverIds.has(token.id)) cls += ' bg-yellow-200 border-yellow-400';
    if (isTemp) cls += ' opacity-60';

    span.className = cls;
    span.textContent = displayText;

    // Don't attach interactive handlers to temp tokens
    if (isTemp) return span;

    // Hover: show tooltip after 400ms
    span.addEventListener('mouseenter', () => {
      if (isDragging) {
        handleDragEnter(token);
        return;
      }
      if (hoverTimeout) clearTimeout(hoverTimeout);
      if (closeTimeout) clearTimeout(closeTimeout);
      hoverTimeout = setTimeout(() => {
        hoveredToken = token;
        if (!editingToken) showTooltip(span, token, isSentStart, mwtInfo);
      }, 400);
    });

    span.addEventListener('mouseleave', () => {
      if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
      closeTimeout = setTimeout(() => {
        if (!hoveredToken || hoveredToken.id !== token.id) {
          hoveredToken = null;
          dismissTooltip();
        }
      }, 300);
    });

    // Click: toggle sentence start
    span.addEventListener('click', (e) => {
      if (isDragging) return;
      if (e.target.closest('[data-action]')) return;
      toggleSentence(token.id);
    });

    // MWT drag: mousedown
    span.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      dragStartToken = token;
      dragOverIds = new Set([token.id]);
      suppressTextSelection = true;
      e.preventDefault();
      e.stopPropagation();
      document.onselectstart = () => false;
      document.ondragstart = () => false;
      updateDragHighlights();
    });

    return span;
  }

  // ── MWT drag ─────────────────────────────────────────────────
  function handleDragEnter(token) {
    if (!isDragging || !dragStartToken) return;
    const { tokens } = getEffectiveState();
    const startIdx = tokens.findIndex(t => t.id === dragStartToken.id);
    const curIdx = tokens.findIndex(t => t.id === token.id);
    if (startIdx === -1 || curIdx === -1) return;

    const lo = Math.min(startIdx, curIdx);
    const hi = Math.max(startIdx, curIdx);
    const range = tokens.slice(lo, hi + 1);

    // Contiguity check
    let contiguous = true;
    for (let i = 1; i < range.length; i++) {
      const hasIntervening = tokens.some(t => {
        if (range.includes(t)) return false;
        return t.begin >= range[i - 1].end && t.begin < range[i].begin;
      });
      if (hasIntervening) { contiguous = false; break; }
    }

    if (contiguous) {
      dragOverIds = new Set(range.map(t => t.id));
    }
    updateDragHighlights();
  }

  function updateDragHighlights() {
    container.querySelectorAll('[data-token-id]').forEach(el => {
      const tid = el.dataset.tokenId;
      el.classList.toggle('bg-yellow-200', dragOverIds.has(tid));
      el.classList.toggle('border-yellow-400', dragOverIds.has(tid));
    });
  }

  function handleMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    document.onselectstart = null;
    document.ondragstart = null;

    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();

    if (dragOverIds.size >= 2) {
      const { info, tokens } = getEffectiveState();
      const selectedTokens = tokens.filter(t => dragOverIds.has(t.id));
      const tokenIds = selectedTokens.map(t => t.id);

      if (info.mwtLayer) {
        // Optimistic MWT add
        const mwtTempId = tempId();
        pendingMwtAdds.push({ id: mwtTempId, tokenIds });
        render();
        onUpdate();
        backgroundSync(() => client.spans.create(info.mwtLayer.id, tokenIds, null));
      }
    }

    dragStartToken = null;
    dragOverIds = new Set();
    setTimeout(() => { suppressTextSelection = false; }, 100);
    updateDragHighlights();
  }

  document.addEventListener('mouseup', handleMouseUp);

  // ── Keyboard shortcuts ───────────────────────────────────────
  function handleKeyDown(event) {
    if (!hoveredToken || editingToken) return;
    const { key } = event;
    let newBegin = hoveredToken.begin;
    let newEnd = hoveredToken.end;
    const text = doc.textBody;

    switch (key) {
      case 's': newBegin = hoveredToken.begin - 1; break;
      case 'S': newBegin = hoveredToken.begin + 1; break;
      case 'd': newEnd = hoveredToken.end + 1; break;
      case 'D': newEnd = hoveredToken.end - 1; break;
      default: return;
    }

    if (newBegin < 0 || newEnd > text.length || newBegin > newEnd) return;
    if (newBegin === hoveredToken.begin && newEnd === hoveredToken.end) return;

    event.preventDefault();

    const tokenId = hoveredToken.id;

    // Optimistic update
    pendingTokenUpdates.set(tokenId, { begin: newBegin, end: newEnd });
    hoveredToken = { ...hoveredToken, begin: newBegin, end: newEnd };
    render();
    onUpdate();

    backgroundSync(() => client.tokens.update(tokenId, newBegin, newEnd));
  }

  document.addEventListener('keydown', handleKeyDown);

  // ── Text selection → token creation ──────────────────────────
  function handleTextSelection() {
    if (isDragging || suppressTextSelection) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) return;

    // Must be within our container
    if (!container.contains(range.commonAncestorContainer)) return;

    const selectedText = range.toString();
    if (!selectedText || selectedText.length === 0) return;

    const text = doc.textBody;

    // Walk text nodes to map DOM positions → text offsets
    const textPositionMap = [];
    let textPos = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (parent && parent.closest('.z-10')) return NodeFilter.FILTER_REJECT;
        if (parent && parent.classList.contains('absolute')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.textContent.length; i++) {
        textPositionMap.push({ node, nodeOffset: i, textPosition: textPos });
        textPos++;
      }
    }

    let selStart = -1, selEnd = -1;
    for (let i = 0; i < textPositionMap.length; i++) {
      const m = textPositionMap[i];
      if (m.node === range.startContainer && m.nodeOffset === range.startOffset) selStart = m.textPosition;
      if (m.node === range.endContainer && m.nodeOffset === range.endOffset) { selEnd = m.textPosition; break; }
    }

    if (selEnd === -1 && range.endContainer === container) selEnd = text.length;
    if (selEnd === -1 && range.endContainer.nodeType === Node.TEXT_NODE) {
      for (let i = 0; i < textPositionMap.length; i++) {
        const m = textPositionMap[i];
        if (m.node === range.endContainer && m.nodeOffset === range.endOffset - 1) {
          selEnd = m.textPosition + 1;
          break;
        }
      }
    }

    if (selStart === -1 || selEnd === -1 || selStart >= selEnd) return;

    const calculated = text.slice(selStart, selEnd);
    if (calculated !== selectedText) {
      const idx = text.indexOf(selectedText);
      if (idx === -1) return;
      selStart = idx;
      selEnd = idx + selectedText.length;
    }

    // Overlap check against effective tokens
    const { tokens } = getEffectiveState();
    const overlaps = tokens.some(t => selStart < t.end && selEnd > t.begin);
    if (overlaps) return;

    selection.removeAllRanges();

    // Optimistic add with temp ID
    const tid = tempId();
    pendingTokenAdds.push({ id: tid, begin: selStart, end: selEnd });
    render();
    onUpdate();

    // Background: create token + lemma span, then sync
    const info = doc.layerInfo;
    const textId = info.textLayer?.text?.id;
    if (!textId || !info.tokenLayer) return;

    backgroundSync(async () => {
      await doc.createToken(textId, selStart, selEnd);
      await doc.reload();
      const newTokens = doc.layerInfo.tokenLayer?.tokens ?? [];
      const created = newTokens.find(t => t.begin === selStart && t.end === selEnd);
      if (created && doc.layerInfo.lemmaLayer) {
        await doc.ensureLemmaSpan(created.id);
      }
    });
  }

  // ── Main render ──────────────────────────────────────────────
  function render() {
    const { tokens, sentenceStarts, mwtMap, text } = getEffectiveState();

    container.innerHTML = '';
    dismissTooltip();
    dismissEditModal();

    // Outer wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'p-4 bg-white rounded border border-gray-200 font-mono text-sm leading-relaxed select-text';

    if (!text) {
      wrapper.innerHTML = '<p class="text-center py-8 text-gray-500">No text to visualize</p>';
      container.appendChild(wrapper);
      return;
    }

    if (tokens.length === 0) {
      wrapper.textContent = text;
      wrapper.addEventListener('mouseup', handleTextSelection);
      container.appendChild(wrapper);

      const hint = document.createElement('p');
      hint.className = 'mt-4 text-sm text-gray-500 text-center';
      hint.textContent = 'No tokens yet. Click "Whitespace Tokenize" to create tokens, or select text to create individual tokens.';
      container.appendChild(hint);
      return;
    }

    // Group tokens into sentences
    const sentences = [];
    let currentSentence = [];

    for (const token of tokens) {
      if (sentenceStarts.has(token.id) && currentSentence.length > 0) {
        sentences.push(currentSentence);
        currentSentence = [];
      }
      currentSentence.push(token);
    }
    if (currentSentence.length > 0) sentences.push(currentSentence);

    // Render each sentence
    sentences.forEach((sentenceTokens, sentenceIdx) => {
      const row = document.createElement('div');
      row.className = 'mb-2 relative';

      let lastEnd = sentenceIdx === 0 ? 0 : sentences[sentenceIdx - 1][sentences[sentenceIdx - 1].length - 1].end;

      // Group tokens by MWT or individual
      const groups = [];
      let currentGroup = null;

      for (const token of sentenceTokens) {
        const mwtInfo = mwtMap.get(token.id);
        if (mwtInfo) {
          if (!currentGroup || currentGroup.type !== 'mwt' || currentGroup.spanId !== mwtInfo.spanId) {
            currentGroup = { type: 'mwt', spanId: mwtInfo.spanId, tokens: [token] };
            groups.push(currentGroup);
          } else {
            currentGroup.tokens.push(token);
          }
        } else {
          groups.push({ type: 'individual', tokens: [token] });
          currentGroup = null;
        }
      }

      // Render groups
      for (const group of groups) {
        const firstToken = group.tokens[0];

        // Inter-token text
        if (firstToken.begin > lastEnd) {
          const between = document.createElement('span');
          between.className = 'text-gray-400';
          between.textContent = text.slice(lastEnd, firstToken.begin);
          row.appendChild(between);
        }

        if (group.type === 'mwt') {
          const mwtWrapper = document.createElement('span');
          mwtWrapper.className = 'relative inline-block ml-0.5 mr-0.5';

          for (let i = 0; i < group.tokens.length; i++) {
            const token = group.tokens[i];
            const mwtInfo = mwtMap.get(token.id);
            const isSentStart = sentenceStarts.has(token.id);
            let pos = 'middle';
            if (i === 0) pos = 'first';
            if (i === group.tokens.length - 1) pos = 'last';
            if (group.tokens.length === 1) pos = 'first';

            const el = makeTokenEl(token, isSentStart, mwtInfo, pos);
            mwtWrapper.appendChild(el);
          }

          // Orange delete bar
          const bar = document.createElement('div');
          bar.className = 'absolute left-0 right-0 h-1 bg-orange-500 hover:bg-orange-600 transition-colors rounded cursor-pointer';
          bar.style.bottom = '-2px';
          bar.style.zIndex = '20';
          bar.style.height = '4px';
          bar.title = 'Click to delete MWT';
          bar.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Optimistic MWT delete
            pendingMwtDeletes.add(group.spanId);
            render();
            onUpdate();
            backgroundSync(() => client.spans.delete(group.spanId));
          });
          mwtWrapper.appendChild(bar);

          row.appendChild(mwtWrapper);
        } else {
          const token = group.tokens[0];
          const isSentStart = sentenceStarts.has(token.id);
          const el = makeTokenEl(token, isSentStart, null, null);
          row.appendChild(el);
        }

        lastEnd = group.tokens[group.tokens.length - 1].end;
      }

      // Remaining text after last token (only in last sentence)
      if (sentenceIdx === sentences.length - 1 && lastEnd < text.length) {
        const remaining = document.createElement('span');
        remaining.className = 'text-gray-400';
        remaining.textContent = text.slice(lastEnd);
        row.appendChild(remaining);
      }

      wrapper.appendChild(row);
    });

    wrapper.addEventListener('mouseup', () => {
      if (!isDragging && !suppressTextSelection) handleTextSelection();
    });

    container.appendChild(wrapper);
  }

  // Initial render
  render();

  return {
    render,
    destroy() {
      clearHoverState();
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      document.onselectstart = null;
      document.ondragstart = null;
      container.innerHTML = '';
    }
  };
}
