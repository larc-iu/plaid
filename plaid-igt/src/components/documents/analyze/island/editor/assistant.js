import { html } from 'lit-html';

// The assistant's mark, for lit. The React copy and its reasoning are in
// plaid-ui/src/components/assistant/PlaidMarks.jsx: keep the two in step,
// and read that one first.
//
// The clip id carries the sentence index. One of these renders per sentence, so
// a fixed id would put dozens of identical `clipPath` definitions under one id
// in the document and leave the browser to pick by document order. It happens
// to look right, because every instance clips to the same shape, and that is
// exactly the kind of accidental correctness that breaks the first time the
// shape changes.
const assistantMark = (index) => {
  const clip = `igt-ask-clip-${index}`;
  return html`
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
      <defs>
        <clipPath id=${clip}><circle cx="12" cy="12" r="9.5" /></clipPath>
      </defs>
      <g clip-path="url(#${clip})">
        <rect x="2.5" y="2.5" width="19" height="19" fill="#1e293b" />
        <rect x="2.5" y="2.5" width="6.5" height="19" fill="#7f1d1d" opacity="0.72" />
        <rect x="2.5" y="2.5" width="19" height="6.5" fill="#7f1d1d" opacity="0.72" />
        <rect x="14.2" y="2.5" width="2.6" height="19" fill="#4d7c0f" opacity="0.5" />
        <rect x="2.5" y="14.2" width="19" height="2.6" fill="#4d7c0f" opacity="0.5" />
        <rect x="11.4" y="2.5" width="0.9" height="19" fill="#d6d3d1" opacity="0.85" />
        <rect x="2.5" y="11.4" width="19" height="0.9" fill="#d6d3d1" opacity="0.85" />
      </g>
    </svg>
  `;
};

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
        ${assistantMark(index)} Ask
      </button>
    `;
  },
};
