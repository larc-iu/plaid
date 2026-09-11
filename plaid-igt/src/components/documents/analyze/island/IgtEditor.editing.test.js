import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { notifyInfo } from '@/utils/feedback';

// The everyday editing paths of the interlinear editor: what a commit writes
// and with which provenance, what a structural morpheme edit leaves in the
// cells around it, and where focus lands. Each of these is a DOM interaction
// against the real IgtDocument and the in-memory fake client, so it sees the
// same render/commit interleavings the browser does.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const LEIPZIG = {
  delimiters: '',
  mode: 'closed',
  values: [{ value: 'PL' }, { value: 'NOM' }, { value: 'ABL' }],
};

// A span a service wrote: unverified, with the prediction extras a model
// records beside its choice.
const MACHINE = {
  prov: 'inferred',
  provSource: 'service:x',
  provProb: 0.8,
  provDetail: { value: 'PL', valueProbs: { PL: 0.8, NOM: 0.2 } },
};

let host;
let editor;

// A contributor: a member whose work the project reviews (plaid.review).
const ANN = { id: 'ann@x.com', isAdmin: false };
const CONTRIBUTED = { prov: 'contributed', provSource: 'user:ann@x.com' };

// `tagset`, when given, governs the morpheme-scope Gloss field (msl-0).
// `contributor` mounts the editor as ANN in a project that reviews her work.
function mount({ tagset = null, contributor = false, morphemes = undefined } = {}) {
  const raw = buildRawDoc(morphemes === undefined ? {} : { morphemes });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const igt = tagset ? { tagsets: { Leipzig: tagset } } : {};
  const plaid = contributor ? { review: { users: [ANN.id] } } : {};
  if (tagset) {
    const morphLayer = raw.textLayers[0].tokenLayers
      .flatMap((tl) => tl.spanLayers || [])
      .find((sl) => sl.id === 'msl-0');
    morphLayer.config.igt.tagset = 'Leipzig';
  }
  const doc = new IgtDocument({
    raw,
    project: {
      id: 'proj-1',
      vocabs: [],
      config: { plaid, igt },
      maintainers: ['lead@x.com'],
      writers: [ANN.id],
    },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: contributor ? ANN : null,
  });
  // A reload (what a failed save does) hands back the document as it stands,
  // as a server would, rather than the pristine fixture.
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const glossOf = (doc, i = 0) => doc.sentences[0].tokens[0].morphemes[i].annotations.Gloss;
const formsOf = (doc) => doc.sentences[0].tokens[0].morphemes.map((m) => m.metadata.form);
const formCells = () =>
  [...host.querySelectorAll('input[data-word="w-1"][data-prec]')].map((c) => c.value);

const focus = (el) => el.focus();
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el, k, init = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
// Commits and structural edits run through the op chain; a few ticks settle
// even a chained split.
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  resetIds();
  vi.mocked(notifyInfo).mockClear();
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a value picked from the list', () => {
  it('into an empty cell is written born-verified with the row as its source', async () => {
    const { doc } = mount();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    editor._pickAlt(c, { value: 'cat', source: 'gloss:precedent' });
    await settle();
    expect(glossOf(doc).value).toBe('cat');
    expect(glossOf(doc).metadata).toEqual({
      prov: 'inferred',
      provSource: 'gloss:precedent',
      provConfirmed: true,
      provDetail: { value: 'cat' },
    });
  });

  it('leaves no trace once written: clearing the cell later deletes the span', async () => {
    // The pick used to be parked in the cell's data-guess-* attributes, which
    // lit does not rewrite when it computes the same value as last time. So
    // they outlived the write, and Enter on the cell after clearing it
    // "adopted" the stale pick back instead of deleting.
    const { doc } = mount();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    editor._pickAlt(c, { value: 'cat', source: 'gloss:precedent' });
    await settle();
    expect(document.activeElement).toBe(c);
    type(c, '');
    key(c, 'Enter');
    await settle();
    expect(glossOf(doc)).toBeNull();
    expect(cell('ma:m-1:Gloss').value).toBe('');
  });

  it('over a stored machine value is a correction: the value changes, its provenance stays, and it is verified', async () => {
    // Stamping the pick's own born-verified fragment over a model's span
    // replaced provSource and provDetail with the picker's, while provProb kept
    // the model's number: a span that said "precedent, 80% sure". A person
    // choosing a different value for a model's span is an ordinary edit of it.
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', MACHINE);
    await settle();
    const c = cell('ma:m-1:Gloss');
    expect(c.classList.contains('igt-field--machine')).toBe(true);
    focus(c);
    editor._pickAlt(c, { value: 'NOM', source: 'gloss:precedent' });
    await settle();
    const span = glossOf(doc);
    expect(span.value).toBe('NOM');
    expect(span.metadata).toEqual({ ...MACHINE, provConfirmed: true });
  });
});

describe('as a contributor', () => {
  it('a typed value is written contributed, and renders amber', async () => {
    const { doc } = mount({ contributor: true });
    expect(doc.isContributor).toBe(true);
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'cat');
    key(c, 'Enter');
    await settle();
    expect(glossOf(doc).value).toBe('cat');
    expect(glossOf(doc).metadata).toEqual(CONTRIBUTED);
    expect(cell('ma:m-1:Gloss').classList.contains('igt-field--contributed')).toBe(true);
    expect(cell('ma:m-1:Gloss').title).toBe('cat: contributed, awaiting review');
  });

  it('a picked value is contributed too, with the guess kept as detail', async () => {
    const { doc } = mount({ contributor: true });
    const c = cell('ma:m-1:Gloss');
    focus(c);
    editor._pickAlt(c, { value: 'cat', source: 'gloss:precedent' });
    await settle();
    expect(glossOf(doc).metadata).toEqual({
      ...CONTRIBUTED,
      provDetail: { value: 'cat', guess: 'gloss:precedent' },
    });
  });

  it('editing a machine value marks it contributed and keeps the prediction as history', async () => {
    const { doc } = mount({ contributor: true });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', MACHINE);
    await settle();
    const c = cell('ma:m-1:Gloss');
    expect(c.classList.contains('igt-field--machine')).toBe(true);
    focus(c);
    type(c, 'NOM');
    key(c, 'Enter');
    await settle();
    const span = glossOf(doc);
    expect(span.value).toBe('NOM');
    expect(span.metadata).toEqual({
      ...CONTRIBUTED,
      provProb: 0.8,
      provDetail: { value: 'PL', valueProbs: { PL: 0.8, NOM: 0.2 } },
    });
    expect(span.metadata.provConfirmed).toBeUndefined();
  });

  it('editing a confirmed value takes its confirmation away', async () => {
    const { doc } = mount({ contributor: true });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', { ...MACHINE, provConfirmed: true });
    await settle();
    expect(cell('ma:m-1:Gloss').classList.contains('igt-field--verified')).toBe(true);
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'NOM');
    key(c, 'Enter');
    await settle();
    expect(glossOf(doc).metadata.provConfirmed).toBeUndefined();
    expect(glossOf(doc).metadata.prov).toBe('contributed');
    expect(cell('ma:m-1:Gloss').classList.contains('igt-field--contributed')).toBe(true);
  });

  it('Ctrl+Enter takes a machine proposal as a contribution, and has nothing to take on contributed work', async () => {
    const { doc } = mount({ contributor: true });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', MACHINE);
    await settle();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    key(c, 'Enter', { ctrlKey: true });
    await settle();
    expect(glossOf(doc).metadata.prov).toBe('contributed');
    expect(glossOf(doc).metadata.provSource).toBe('user:ann@x.com');
    expect(glossOf(doc).metadata.provConfirmed).toBeUndefined();
    // The contributed cell is not a review stop for a contributor.
    expect(editor._wordHasUnverified('w-1')).toBe(false);
    focus(cell('ma:m-1:Gloss'));
    key(cell('ma:m-1:Gloss'), 'Enter', { ctrlKey: true });
    await settle();
    expect(notifyInfo).toHaveBeenCalled();
  });
});

describe('as a verifier over contributed work', () => {
  it('sees it as a review stop, and editing it confirms it with the contributor kept as its source', async () => {
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', CONTRIBUTED);
    await settle();
    const c = cell('ma:m-1:Gloss');
    expect(c.classList.contains('igt-field--contributed')).toBe(true);
    expect(c.title).toBe(
      'PL: contributed, unverified. Edit to fix, Ctrl+Enter accepts the whole word',
    );
    expect(editor._wordHasUnverified('w-1')).toBe(true);
    focus(c);
    type(c, 'NOM');
    key(c, 'Enter');
    await settle();
    expect(glossOf(doc).metadata).toEqual({ ...CONTRIBUTED, provConfirmed: true });
    expect(cell('ma:m-1:Gloss').classList.contains('igt-field--verified')).toBe(true);
    expect(cell('ma:m-1:Gloss').title).toBe('NOM: contributed, confirmed');
  });

  it('Ctrl+Enter confirms it as is', async () => {
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', CONTRIBUTED);
    await settle();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    key(c, 'Enter', { ctrlKey: true });
    await settle();
    expect(glossOf(doc).metadata).toEqual({ ...CONTRIBUTED, provConfirmed: true });
  });

  // Confirming and hopping used to land in the same frame, so a reviewer saw
  // neither: the word went plain exactly as the browser jumped the view to the
  // next cell. Nothing covered the hop at all, so nothing would have caught
  // this changing either way.
  describe('the beat between confirming and moving on', () => {
    const wordCell = (k) => cell(k);

    it('pulses the confirmed word and holds focus for a beat before hopping', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { doc } = mount();
        await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', CONTRIBUTED);
        await settle();
        const c = wordCell('ma:m-1:Gloss');
        focus(c);
        key(c, 'Enter', { ctrlKey: true });
        await settle();

        // The word says it took it, and the caret has NOT moved yet.
        const col = host.querySelector('[data-word-col="w-1"]');
        expect(col.classList.contains('igt-confirmed')).toBe(true);
        expect(document.activeElement).toBe(c);

        vi.advanceTimersByTime(250);
        await settle();
        expect(document.activeElement).not.toBe(c);
      } finally {
        vi.useRealTimers();
      }
    });

    // The sentence gesture is the word gesture's counterpart and had neither
    // half: it confirmed and jumped to the NEXT SENTENCE in one frame.
    it('pulses a confirmed sentence field and holds focus before the next sentence', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { doc } = mount();
        await doc.updateSentenceSpan('s-1', 'Translation', 'the dog', MACHINE);
        await settle();
        const t = cell('sa:s-1:Translation');
        focus(t);
        key(t, 'Enter', { ctrlKey: true });
        await settle();

        expect(t.closest('.igt-sentence-anno').classList.contains('igt-confirmed')).toBe(true);
        expect(document.activeElement).toBe(t);

        vi.advanceTimersByTime(250);
        await settle();
        expect(document.activeElement).not.toBe(t);
      } finally {
        vi.useRealTimers();
      }
    });

    // An edited value is an edit, not an accept: it commits on the way out and
    // must not be held back or washed.
    it('does not pulse or wait when the sentence value was edited instead', async () => {
      const { doc } = mount();
      await doc.updateSentenceSpan('s-1', 'Translation', 'the dog', MACHINE);
      await settle();
      const t = cell('sa:s-1:Translation');
      focus(t);
      type(t, 'the cat');
      key(t, 'Enter', { ctrlKey: true });
      expect(t.closest('.igt-sentence-anno').classList.contains('igt-confirmed')).toBe(false);
      expect(document.activeElement).not.toBe(t);
      await settle();
    });

    it('flushes the beat the moment anything else is typed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { doc } = mount();
        await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', CONTRIBUTED);
        await settle();
        const c = wordCell('ma:m-1:Gloss');
        focus(c);
        key(c, 'Enter', { ctrlKey: true });
        await settle();
        expect(document.activeElement).toBe(c);

        // Without waiting out the beat: the next keystroke moves focus first,
        // so the character lands where the reader is looking.
        key(c, 'x');
        await settle();
        expect(document.activeElement).not.toBe(c);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('Ctrl+Backspace discards it', async () => {
    // The gesture reaches the domain (which the document tests cover: a
    // verifier's discard takes contributed work); the fake client's reload
    // cannot show the deletion, so the call is what is asserted here.
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', CONTRIBUTED);
    await settle();
    const spy = vi.spyOn(doc, 'discardWordAnalysis').mockResolvedValue(true);
    const c = cell('ma:m-1:Gloss');
    focus(c);
    const e = key(c, 'Backspace', { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalledWith('w-1');
  });
});

describe('splitting a morpheme form', () => {
  it('in the middle writes the split once, with no form update trailing it', async () => {
    // The render that follows the split clears the source cell's commit
    // suppression, and the blur that follows found the cell's text differing
    // from what it was focused with, so every mid-word split was followed by a
    // second, redundant write of the left-hand form.
    const { doc } = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeForm');
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(2, 2);
    key(f, '-');
    await settle();
    expect(formsOf(doc)).toEqual(['th', 'e']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('at the right edge leaves the new cell empty, not showing the whole word', async () => {
    // A morpheme with no form of its own renders the word's text (that is how
    // a word's single default morpheme shows the word). A split-created piece
    // with nothing after the caret was written without a form, so typing
    // "ngo-" showed [ngo][ngoko], with the caret at the start of the second.
    const { doc } = mount();
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(3, 3);
    key(f, '-');
    await settle();
    expect(formsOf(doc)).toEqual(['the', '']);
    expect(formCells()).toEqual(['the', '']);
    expect(document.activeElement.dataset.prec).toBe('2');
  });

  it('typed faster than the server answers still lands every piece in its own cell', async () => {
    // "the-ko-mi" in one burst: the second "-" arrives while the first split
    // is in flight. It used to replay as one cell holding "komi" beside a cell
    // holding "mi", and the next Enter wrote "komi" over the "ko" the chained
    // split had just stored.
    const { doc } = mount();
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(3, 3);
    key(f, '-');
    for (const k of ['k', 'o', '-', 'm', 'i']) key(f, k);
    await settle(10);
    expect(formsOf(doc)).toEqual(['the', 'ko', 'mi']);
    expect(formCells()).toEqual(['the', 'ko', 'mi']);
    expect(document.activeElement.dataset.prec).toBe('3');
    expect(document.activeElement.value).toBe('mi');
    key(document.activeElement, 'Enter');
    await settle();
    expect(formsOf(doc)).toEqual(['the', 'ko', 'mi']);
  });

  it('honors an Enter buffered behind a chained split once the last piece exists', async () => {
    const { doc } = mount();
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(3, 3);
    key(f, '-');
    for (const k of ['k', 'o', '-', 'm', 'i', 'Enter']) key(f, k);
    await settle(10);
    expect(formsOf(doc)).toEqual(['the', 'ko', 'mi']);
    // Enter commits and moves on; with no geometry to move along, that is a blur.
    expect(host.contains(document.activeElement)).toBe(false);
  });

  it('a Backspace typed mid-flight takes back the boundary just typed, not the letter before it', async () => {
    const { doc } = mount();
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(3, 3);
    key(f, '-');
    for (const k of ['k', 'o', '-', 'Backspace', 'm']) key(f, k);
    await settle(10);
    // No boundary survived, so the letters are simply typed into the new cell,
    // committed by the Enter that would follow.
    expect(document.activeElement.dataset.prec).toBe('2');
    expect(document.activeElement.value).toBe('kom');
    key(document.activeElement, 'Enter');
    await settle();
    expect(formsOf(doc)).toEqual(['the', 'kom']);
  });
});

describe('a word nobody has analyzed', () => {
  // Its morpheme is synthesized, not stored (domain/virtualMorpheme.js). The
  // first commit into it writes the token, which changes the id every cell in
  // that column is keyed by, and the caret has already moved on to the next
  // cell of the same column by then.
  it('keeps the caret where the user put it when the first commit writes the morpheme', async () => {
    const { doc } = mount({ morphemes: [] });
    await settle();
    const form = cell('mf:virtual:w-1');
    focus(form);
    type(form, 'ngo');
    // Down into the gloss of the same morpheme, which commits the form behind it.
    const gloss = cell('ma:virtual:w-1:Gloss');
    focus(gloss);
    await settle();

    const m = doc.sentences[0].tokens[0].morphemes[0];
    expect(m.virtual).toBeUndefined();
    expect(m.metadata.form).toBe('ngo');
    expect(document.activeElement).toBe(cell(`ma:${m.id}:Gloss`));
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it('writes the gloss typed into it against the morpheme it just became', async () => {
    const { doc, client } = mount({ morphemes: [] });
    await settle();
    const gloss = cell('ma:virtual:w-1:Gloss');
    focus(gloss);
    type(gloss, 'dog');
    gloss.blur();
    await settle();

    const m = doc.sentences[0].tokens[0].morphemes[0];
    expect(m.annotations.Gloss?.value).toBe('dog');
    const spans = client.calls.filter((c) => c.kind === 'spans.create');
    expect(spans).toHaveLength(1);
    expect(spans[0].args[1]).toEqual([m.id]);
    expect(m.id.startsWith('virtual:')).toBe(false);
  });
});

describe('pasting a morpheme chain', () => {
  it('lands focus on the last new piece and writes nothing behind the split', async () => {
    // The source cell is disabled while the paste-split is in flight. A
    // disabled input can still be document.activeElement, and the focus
    // restore read that as "the user moved focus" and left it there.
    const { doc } = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeForm');
    const f = cell('mf:m-1');
    focus(f);
    f.setSelectionRange(0, 3);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => 'a-b' };
    f.dispatchEvent(paste);
    await settle();
    expect(formsOf(doc)).toEqual(['a', 'b']);
    expect(document.activeElement.dataset.prec).toBe('2');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('a refused value', () => {
  it('loses its squiggle once Escape puts the saved value back', async () => {
    // The squiggle is added by hand at refusal time (nothing re-renders), and
    // nothing took it away when the text went back to a value that is fine.
    const { doc } = mount({ tagset: LEIPZIG });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'XYZ');
    c.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();
    expect(c.classList.contains('igt-field--invalid')).toBe(true);
    key(c, 'Escape');
    expect(c.value).toBe('PL');
    expect(c.classList.contains('igt-field--invalid')).toBe(false);
  });

  it('loses it when corrected to a legal value too', async () => {
    const { doc } = mount({ tagset: LEIPZIG });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'XYZ');
    c.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();
    type(c, 'NOM');
    c.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();
    expect(glossOf(doc).value).toBe('NOM');
    expect(cell('ma:m-1:Gloss').classList.contains('igt-field--invalid')).toBe(false);
  });
});

describe('Escape', () => {
  it('leaves a cell it emptied styled as empty', () => {
    // Typing flips the filled/empty classes by hand; the revert did not flip
    // them back, and lit only rewrites the class attribute when one of its own
    // interpolations changes.
    mount();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'x');
    expect(c.classList.contains('igt-field--filled')).toBe(true);
    key(c, 'Escape');
    expect(c.value).toBe('');
    expect(c.classList.contains('igt-field--empty')).toBe(true);
    expect(c.classList.contains('igt-field--filled')).toBe(false);
  });
});

describe('while an IME composition is open', () => {
  // Enter confirms a candidate, Escape cancels the composition, Tab may
  // convert: none of them is the editor's until the composition is over.
  const composing = { isComposing: true };

  it('Enter, Tab and Escape stay with the composition on an annotation cell', async () => {
    const { doc } = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan');
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'ni');
    for (const k of ['Enter', 'Tab', 'Escape']) {
      const e = key(c, k, composing);
      expect(e.defaultPrevented).toBe(false);
    }
    await settle();
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('ni');
    expect(spy).not.toHaveBeenCalled();
  });

  it('and on a morpheme form cell', async () => {
    mount();
    const f = cell('mf:m-1');
    focus(f);
    type(f, 'ni');
    key(f, 'Enter', composing);
    key(f, 'Escape', composing);
    await settle();
    expect(document.activeElement).toBe(f);
    expect(f.value).toBe('ni');
  });

  it('and on a translation field', async () => {
    mount();
    const t = cell('sa:s-1:Translation');
    focus(t);
    type(t, 'ni');
    key(t, 'Enter', composing);
    await settle();
    expect(document.activeElement).toBe(t);
    expect(t.value).toBe('ni');
  });
});

describe('Ctrl+Backspace on a word', () => {
  it('with nothing unverified holds position and says so, as Ctrl+Enter does', async () => {
    // It used to suppress the cell's commit and hop regardless, so on a word
    // with no proposal it silently dropped whatever the cell held.
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const spy = vi.spyOn(doc, 'discardWordAnalysis');
    const c = cell('ma:m-1:Gloss');
    focus(c);
    const e = key(c, 'Backspace', { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('PL');
    expect(spy).not.toHaveBeenCalled();
    expect(notifyInfo).toHaveBeenCalled();
  });

  it('with text typed and not yet saved is left to the browser, and the text is kept', async () => {
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', MACHINE);
    await settle();
    const spy = vi.spyOn(doc, 'discardWordAnalysis');
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'PLX');
    const e = key(c, 'Backspace', { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('PLX');
    expect(spy).not.toHaveBeenCalled();
  });

  it('over an untouched cell of a word with a proposal discards it', async () => {
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', MACHINE);
    await settle();
    const spy = vi.spyOn(doc, 'discardWordAnalysis').mockResolvedValue(true);
    const c = cell('ma:m-1:Gloss');
    focus(c);
    const e = key(c, 'Backspace', { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(spy).toHaveBeenCalledWith('w-1');
  });
});

describe('a failed save', () => {
  it('puts the typed value back with the SAVED value as what Escape reverts to', async () => {
    const { doc, client } = mount();
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const update = client.spans.update;
    client.spans.update = () => {
      throw new Error('boom');
    };
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'NOM');
    c.blur();
    await settle();
    client.spans.update = update;
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('NOM');
    expect(c.dataset.orig).toBe('PL');
    key(c, 'Escape');
    expect(c.value).toBe('PL');
  });
});

describe('a cell that is focused but untouched', () => {
  it('shows a value that changed underneath it, and takes it as the new baseline', async () => {
    // What a whole-word accept does to the very cell it was pressed in: the
    // guess it showed becomes a span, and the cell, still focused, went on
    // showing nothing.
    const { doc } = mount();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('PL');
    expect(c.dataset.orig).toBe('PL');
  });

  it('is left alone once the user has typed into it', async () => {
    const { doc } = mount();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    type(c, 'x');
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    expect(c.value).toBe('x');
    expect(c.dataset.orig).toBe('');
  });
});

describe('Ctrl+Backspace on the last word of the page', () => {
  it('keeps focus in the grid rather than dropping it to the body', async () => {
    const { doc } = mount();
    await doc.updateMorphemeSpan('m-2', 'Gloss', 'PL', MACHINE);
    await settle();
    vi.spyOn(doc, 'discardWordAnalysis').mockResolvedValue(true);
    const c = cell('ma:m-2:Gloss');
    focus(c);
    key(c, 'Backspace', { ctrlKey: true });
    await settle();
    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement.dataset.confirmWord).toBe('w-2');
  });
});

describe('Ctrl+Enter while the picker is open', () => {
  it('is the whole-word accept even after arrowing through the list', async () => {
    const { doc } = mount({ tagset: LEIPZIG });
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const c = cell('ma:m-1:Gloss');
    focus(c);
    key(c, 'ArrowDown');
    key(c, 'Enter', { ctrlKey: true });
    await settle();
    expect(c.value).toBe('PL');
    expect(glossOf(doc).value).toBe('PL');
    // A human-made word: nothing to accept, and it says so.
    expect(notifyInfo).toHaveBeenCalled();
  });
});

describe('Escape on a list opened with Alt+Down', () => {
  it('closes the list only and keeps the cell, unlike a list that opened on its own', async () => {
    // The one-press revert for a governed cell (whose list opens on focus)
    // had swallowed this case too: on an ungoverned cell Escape closed the
    // list the user had asked for AND left the cell.
    const { doc } = mount();
    // Two morphemes sharing a form, one glossed: the other has a list to offer.
    await doc.updateMorphemeForm('m-1', 'xx');
    await doc.updateMorphemeForm('m-2', 'xx');
    await doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null);
    await settle();
    const c = cell('ma:m-2:Gloss');
    focus(c);
    expect(document.querySelector('.igt-alts')).toBeNull();
    key(c, 'ArrowDown', { altKey: true });
    expect(document.querySelector('.igt-alts')).not.toBeNull();
    key(c, 'Escape');
    expect(document.querySelector('.igt-alts')).toBeNull();
    expect(document.activeElement).toBe(c);
    expect(c.value).toBe('');
  });
});

describe('a focus target handed to a mutation', () => {
  it('is dropped when the mutation turns out to be a no-op', async () => {
    // Otherwise the next unrelated render honored it, wherever focus was.
    mount();
    await editor._runThenFocus({ cellKey: 'ma:m-2:Gloss' }, async () => false);
    expect(editor._pendingFocus).toBeNull();
  });

  it('is honored by the render the mutation causes', async () => {
    const { doc } = mount();
    await editor._runThenFocus({ cellKey: 'ma:m-2:Gloss' }, () =>
      doc.updateMorphemeSpan('m-1', 'Gloss', 'PL', null),
    );
    expect(document.activeElement).toBe(cell('ma:m-2:Gloss'));
  });
});
