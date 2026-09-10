import { html, nothing } from 'lit-html';
import { directive, Directive, PartType } from 'lit-html/directive.js';
import { PROV, provState, PROV_STATES } from '@larc-iu/plaid-client';

// The dotted number that tells an entry apart ("1.2"), drawn after its form as
// a SUBSCRIPT — kai₁, as FieldWorks writes a homograph number. Never a
// superscript: those mark tone. The React counterpart is FormLabel, which
// carries the rest of the story.
export const numHtml = (sub, cls) => (sub ? html`<sub class="${cls}__num">${sub}</sub>` : nothing);

// Stable empty precedent results, so the tally memo does not rebuild on every
// render while the project queries are still in flight.
export const NO_PRECEDENT = Object.freeze({ links: [], values: [] });
export const EMPTY_SET = new Set();
// Minimum time between tab-focus-triggered precedent refetches (see
// _onVisibility in the constructor and the force path in _ensurePrecedent).
export const PRECEDENT_REFRESH_MIN_MS = 60_000;

// ---- uncontrolledValue: set input.value only when the user is not mid-edit
// on it. Keeps programmatic changes (split/merge form rewrites, reloads)
// reflected while never clobbering text the user has typed. A FOCUSED cell is
// still refreshed when it is untouched — showing exactly what it was focused
// with — because then there is nothing of the user's to protect and the
// stored value has moved on underneath (a whole-word accept wrote the guess
// this very cell was showing; a reload brought in another writer's edit).
// The baseline moves with it, so Escape and the change check stay honest.
export class UncontrolledValueDirective extends Directive {
  constructor(partInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error('uncontrolledValue must be used as an element directive');
    }
  }
  update(part, [value]) {
    const el = part.element;
    const v = value ?? '';
    if (el && el.value !== v) {
      if (document.activeElement !== el) {
        el.value = v;
      } else if ((el.dataset.orig ?? '') === el.value) {
        // Focus selects a cell's whole text; keep it that way so typing still
        // replaces.
        const all = el.selectionStart === 0 && el.selectionEnd === el.value.length;
        el.value = v;
        el.dataset.orig = v;
        if (all) {
          try {
            el.select();
          } catch {
            /* not selectable */
          }
        }
      }
    }
    return this.render(value);
  }
  render() {
    return nothing;
  }
}
export const uncontrolledValue = directive(UncontrolledValueDirective);

export const morphFormOf = (m) =>
  m.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form')
    ? (m.metadata.form ?? '')
    : (m.content ?? '');

// Display-relevant provenance of an entity's metadata: null for human-made
// material (renders plain), else 'machine' (unverified: violet + dashed),
// 'contributed' (a writer's unreviewed work: amber + dashed) or 'verified'
// (confirmed: quiet). The state doubles as the CSS modifier suffix
// (igt-field--machine, igt-vocab__hint--verified, igt-legend__prov--machine).
// Empty cells are the caller's concern (_field only styles filled values).
export const provDisplay = (metadata) => {
  const s = provState(metadata);
  return s === PROV_STATES.HUMAN ? null : s;
};
export const provClass = (base, state) => (state ? `${base}--${state}` : '');

// How long the confirmed word is left alone before focus moves on, and how
// long its pulse runs. Short enough that a reviewer working at speed never
// waits, long enough to register what changed.
export const ADVANCE_BEAT_MS = 200;
export const PULSE_MS = 400;
export const PULSE_CLASS = 'igt-confirmed';

// What a marked value's tooltip says of its state. `origin` (provOrigin of
// the entity) tells a verified value's two origins apart; `contributor`
// is whether the person looking is one, whose Ctrl+Enter takes machine
// proposals only.
export const REVIEW_HINT = 'Edit to fix, Ctrl+Enter accepts the whole word';
export const provStateText = (state, origin, contributor) => {
  if (state === PROV_STATES.MACHINE) return `machine-suggested, unverified. ${REVIEW_HINT}`;
  if (state === PROV_STATES.CONTRIBUTED)
    return contributor ? 'contributed, awaiting review' : `contributed, unverified. ${REVIEW_HINT}`;
  return origin === PROV.CONTRIBUTED ? 'contributed, confirmed' : 'machine-suggested, confirmed';
};
export const provTitle = (value, state, origin, contributor) =>
  `${value}: ${provStateText(state, origin, contributor)}`;

// The CSS classes of the marked material this writer reviews (see
// IgtDocument.reviewable): the review sweep's stops and the confirm/discard
// gestures' targets. A verifier reviews machine and contributed material,
// a contributor machine material only.
export const reviewStates = (contributor) =>
  contributor ? [PROV_STATES.MACHINE] : [PROV_STATES.MACHINE, PROV_STATES.CONTRIBUTED];
export const reviewSelector = (bases, contributor) =>
  bases
    .flatMap((b) =>
      reviewStates(contributor).map((s) => (typeof b === 'function' ? b(s) : `${b}--${s}`)),
    )
    .join(', ');
