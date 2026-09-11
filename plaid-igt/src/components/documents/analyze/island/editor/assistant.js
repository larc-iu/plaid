import { html } from 'lit-html';

// Asking the assistant about one sentence.
//
// The island cannot reach the docked panel directly (the panel is React, on
// the page around this), so the gesture goes out as a window event and
// DocumentDetail turns it into the panel's chip. Same bridge the auto-analyze
// opener uses.
//
// The control is only rendered when an assistant is online; `assistantOnline`
// is set on the element by AnalyzeIsland, and lit will not repaint a property
// it thinks unchanged, so it is a property and not an attribute.

export const assistant = {
  // Availability is discovered after the island mounts, so it arrives late and
  // has to repaint. Guarded so a no-op set cannot cause a render loop.
  setAssistantOnline(online) {
    const next = !!online;
    if (this.assistantOnline === next) return;
    this.assistantOnline = next;
    this._render(true);
  },

  // The other direction: a citation in the panel points into THIS document, so
  // put that sentence in view rather than sending the reader to a second
  // browser tab. The island already knows how -- it is the path a deep link
  // takes -- so this only has to hand it the same request.
  _onAssistantFocus(e) {
    const { documentId, focus, begin } = e.detail || {};
    if (!focus || !this.doc || documentId !== this.doc.id) return;
    try {
      sessionStorage.setItem(
        'igt:focus-sentence',
        JSON.stringify({ docId: this.doc.id, sentenceId: focus, begin: begin ?? null }),
      );
    } catch {
      return; // no session storage, no focus: the link still works as a link
    }
    this._consumeFocusRequest();
  },

  _askAssistant(sentence, index) {
    window.dispatchEvent(
      new CustomEvent('igt:ask-assistant', {
        detail: {
          // The addressing the assistant's tools use, and the numbers a read
          // prints: sentences count from 1.
          ref: `s${index + 1}`,
          label: 'Sentence',
          sentenceId: sentence.id,
        },
      }),
    );
  },

  _assistantControl(sentence, index) {
    if (!this.assistantOnline) return null;
    return html`
      <button
        type="button"
        class="igt-ask"
        title="Ask the assistant about this sentence"
        @click=${(e) => {
          e.stopPropagation();
          this._askAssistant(sentence, index);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="8" width="18" height="12" rx="2" />
          <path d="M12 8V5" />
          <circle cx="8.5" cy="14" r="1" />
          <circle cx="15.5" cy="14" r="1" />
        </svg>
        Ask
      </button>
    `;
  },
};
