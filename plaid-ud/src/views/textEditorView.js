import { DocumentStore } from '../model/DocumentStore.js';
import { tokenVisualizer } from './tokenVisualizer.js';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Mount the text editor view into a container div.
 * @param {HTMLElement} container
 * @param {{ client: any, store: DocumentStore }} opts
 * @returns {{ destroy: () => void }}
 */
export function textEditorView(container, { client, store }) {
  const doc = store.document;
  if (!doc) {
    container.innerHTML = '<div class="text-center text-gray-600 py-8">No document loaded</div>';
    return { destroy() {} };
  }

  let info = doc.layerInfo;
  let savedText = doc.textBody;
  let tokViz = null;

  // ── Build DOM ───────────────────────────────────────────────────

  const page = document.createElement('div');
  page.className = 'p-6';

  // Text + Token sections side by side
  page.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
      <div>
        <h3 class="text-lg font-semibold text-gray-900 mb-4">Text Content</h3>
        <textarea
          id="te-textarea"
          class="w-full min-h-[300px] p-4 border-2 border-gray-300 rounded-md font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          rows="12"
          placeholder="Enter your text here..."
        >${esc(savedText)}</textarea>

        <div class="flex items-center gap-3 mt-4">
          <button id="te-save-btn"
            class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            disabled>Save Text</button>
          <button id="te-tokenize-btn"
            class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            disabled>Whitespace Tokenize</button>
          <button id="te-clear-btn"
            class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors hidden">Clear Tokens</button>
          <div id="te-token-count" class="ml-auto text-sm font-medium text-gray-600"></div>
        </div>

        <div id="te-status" class="mt-2 text-sm"></div>
      </div>

      <div class="border border-gray-200 rounded-md p-4 bg-gray-50">
        <h3 class="text-lg font-semibold text-gray-900 mb-4">Token Visualization</h3>
        <div id="te-visualizer" class="token-visualizer"></div>
      </div>
    </div>
  `;

  container.appendChild(page);

  // ── DOM references ───────────────────────────────────────────────
  const textarea = page.querySelector('#te-textarea');
  const saveBtn = page.querySelector('#te-save-btn');
  const tokenizeBtn = page.querySelector('#te-tokenize-btn');
  const clearBtn = page.querySelector('#te-clear-btn');
  const tokenCountEl = page.querySelector('#te-token-count');
  const statusEl = page.querySelector('#te-status');
  const visualizerEl = page.querySelector('#te-visualizer');

  // ── Dirty tracking ───────────────────────────────────────────────
  function checkDirty() {
    const dirty = textarea.value !== savedText;
    saveBtn.disabled = !dirty;
    tokenizeBtn.disabled = dirty || !savedText;
  }
  textarea.addEventListener('input', checkDirty);

  function updateTokenCount() {
    const tokens = info.tokenLayer?.tokens ?? [];
    tokenCountEl.textContent = `${tokens.length} token${tokens.length !== 1 ? 's' : ''}`;
    clearBtn.classList.toggle('hidden', tokens.length === 0);
  }

  // ── Save text ────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    const body = textarea.value;
    statusEl.innerHTML = '<span class="text-blue-600 italic">Saving...</span>';
    try {
      if (info.textLayer?.text) {
        await doc.updateText(body);
      } else {
        await doc.createText(body);
      }
      await doc.reload();
      info = doc.layerInfo;
      savedText = doc.textBody;
      checkDirty();
      statusEl.innerHTML = '<span class="text-green-600">Saved</span>';
      renderTokens();
    } catch (err) {
      statusEl.innerHTML = `<span class="text-red-600">Save failed: ${esc(err.message)}</span>`;
    }
  });

  // ── Tokenize ─────────────────────────────────────────────────────
  tokenizeBtn.addEventListener('click', async () => {
    const text = doc.textBody;
    if (!text || !info.tokenLayer || !info.textLayer?.text) return;

    statusEl.innerHTML = '<span class="text-blue-600 italic">Tokenizing...</span>';
    try {
      const existingTokens = info.tokenLayer.tokens;
      const parts = [];
      const regex = /\S+/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        parts.push({ begin: match.index, end: match.index + match[0].length });
      }

      const newParts = parts.filter(p =>
        !existingTokens.some(t => p.begin < t.end && p.end > t.begin)
      );

      if (newParts.length > 0) {
        const tokenResult = await client.tokens.bulkCreate(
          newParts.map(p => ({
            tokenLayerId: info.tokenLayer.id,
            text: info.textLayer.text.id,
            begin: p.begin,
            end: p.end,
          }))
        );

        // Auto-create lemma spans for new tokens
        await doc.reload();
        info = doc.layerInfo;
        if (info.lemmaLayer && tokenResult?.ids) {
          const lemmaTokenIds = new Set(
            (info.lemmaLayer.spans ?? []).flatMap(s => s.tokens ?? [])
          );
          const lemmaOps = [];
          for (const tid of tokenResult.ids) {
            if (!lemmaTokenIds.has(tid)) {
              const tok = info.tokenLayer.tokens.find(t => t.id === tid);
              if (tok) {
                lemmaOps.push({
                  spanLayerId: info.lemmaLayer.id,
                  tokens: [tid],
                  value: doc.textBody.slice(tok.begin, tok.end),
                });
              }
            }
          }
          if (lemmaOps.length > 0) {
            await client.spans.bulkCreate(lemmaOps);
          }
        }
      }

      await doc.reload();
      info = doc.layerInfo;
      renderTokens();
      statusEl.innerHTML = '<span class="text-green-600">Tokenized</span>';
    } catch (err) {
      statusEl.innerHTML = `<span class="text-red-600">Tokenize failed: ${esc(err.message)}</span>`;
    }
  });

  // ── Clear tokens ─────────────────────────────────────────────────
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete all tokens? This will also delete associated annotations.')) return;
    statusEl.innerHTML = '<span class="text-blue-600 italic">Clearing...</span>';
    try {
      const tokens = info.tokenLayer?.tokens ?? [];
      if (tokens.length > 0) {
        await client.tokens.bulkDelete(tokens.map(t => t.id));
      }
      await doc.reload();
      info = doc.layerInfo;
      renderTokens();
      statusEl.innerHTML = '<span class="text-green-600">Tokens cleared</span>';
    } catch (err) {
      statusEl.innerHTML = `<span class="text-red-600">Clear failed: ${esc(err.message)}</span>`;
    }
  });

  // ── Token visualizer ─────────────────────────────────────────────
  function renderTokens() {
    if (tokViz) tokViz.destroy();
    tokViz = tokenVisualizer(visualizerEl, {
      doc,
      client,
      onUpdate: () => {
        info = doc.layerInfo;
        updateTokenCount();
      },
    });
    updateTokenCount();
  }

  // ── Init ──────────────────────────────────────────────────────────
  checkDirty();
  renderTokens();

  return {
    destroy() {
      if (tokViz) tokViz.destroy();
      page.remove();
    }
  };
}
