import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// The tagset behaviours of the interlinear editor.
//
// These are the ones that carry real logic and had none of it under test: the
// picker opening on focus, a pick replacing the PART under the caret rather
// than the cell, and commit refusing a value the tagset does not allow. Every
// one of them is a DOM interaction, so none is reachable from a domain test.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const LEIPZIG = {
  delimiters: '.',
  mode: 'closed',
  values: [{ value: 'PL' }, { value: '1SG' }, { value: 'NOM' }],
};

// A project whose morpheme-scope Gloss field is governed by `tagset`.
const projectWith = (tagset) => ({
  id: 'proj-1',
  vocabs: [],
  config: { plaid: {}, igt: { tagsets: { Leipzig: tagset } } },
});

// buildRawDoc's morpheme span layer is msl-0; point it at the tagset.
function docWith(tagset) {
  const raw = buildRawDoc();
  // The editor builds its precedent tally from project-wide queries on first
  // render; makeFakeClient has no query, and an empty result is what we want
  // anyway (these tests are about the tagset, not about precedent).
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const morphLayer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'msl-0');
  morphLayer.config.igt.tagset = 'Leipzig';
  return new IgtDocument({
    raw,
    project: projectWith(tagset),
    vocabularies: {},
    client,
    projectId: 'proj-1',
  });
}

let host;
let editor;

const mount = (tagset = LEIPZIG) => {
  const doc = docWith(tagset);
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
};

// The picker renders into its own root at body level, not inside the grid: it
// is position:fixed, and keeping it out of the grid template is what stops a
// focus from re-rendering every cell in the document.
const altsList = () => document.querySelector('.igt-alts');
const altsValues = () =>
  [...document.querySelectorAll('.igt-alts__value')].map((n) => n.textContent);

/** The first morpheme-scope Gloss cell. */
const glossCell = () => host.querySelector('input[data-cell-key^="ma:"]');

const focus = (el) => {
  el.focus();
  el.dispatchEvent(new Event('focus', { bubbles: true }));
};
const type = (el, value) => {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
// Commits run through the editor's op chain, so they land a tick after the
// blur rather than during it.
const flush = () => new Promise((r) => setTimeout(r, 0));
const blur = async (el) => {
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  await flush();
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('a tagset-governed cell', () => {
  it('marks itself so the focus and caret handlers can find it', () => {
    mount();
    const cell = glossCell();
    expect(cell.dataset.hasTagset).toBe('1');
    expect(cell.dataset.tagsetDelims).toBe('.');
  });

  it('leaves an ungoverned cell alone', () => {
    mount();
    // The word-scope POS field (wsl-0) references no tagset.
    const pos = host.querySelector('input[data-cell-key^="wa:"]');
    expect(pos.dataset.hasTagset).toBeUndefined();
    expect(pos.dataset.tagsetDelims).toBeUndefined();
  });

  it('opens its list on FOCUS, not only on Alt+Down', () => {
    // The tagset IS the set of legal values, so a picker you have to know a
    // chord to find leaves a closed field looking broken.
    mount();
    expect(altsList()).toBeNull();
    focus(glossCell());
    expect(altsList()).not.toBeNull();
  });

  it('offers every tagset value even with no precedent in the document', () => {
    mount();
    focus(glossCell());
    expect(altsValues().sort()).toEqual(['1SG', 'NOM', 'PL']);
  });
});

describe('spellcheck', () => {
  // A gloss is not English. Chrome underlines "RqeES.???" in red wavy, which is
  // exactly the marker an off-tagset value gets, so a native squiggle was
  // indistinguishable from a validation failure. Asserted on the rendered DOM,
  // because checking the source for the string is what let a missing attribute
  // through: the word "spellchecker" in a comment satisfied the count.
  it('is off on annotation cells and morpheme forms', () => {
    mount();
    for (const sel of ['input[data-cell-key^="ma:"]', 'input[data-cell-key^="wa:"]']) {
      expect(host.querySelector(sel).getAttribute('spellcheck')).toBe('false');
    }
    const form = host.querySelector('input[data-prec]');
    if (form) expect(form.getAttribute('spellcheck')).toBe('false');
  });

  it('is off on EVERY editable field in the grid, sentence fields included', () => {
    // A red wavy underline has to mean exactly one thing here. Enumerated
    // rather than spot-checked, so a field added later cannot quietly ship
    // with the browser's spellchecker still on.
    mount();
    const editable = [...host.querySelectorAll('input, textarea')].filter(
      (el) => el.type !== 'checkbox' && el.type !== 'radio',
    );
    expect(editable.length).toBeGreaterThan(0);
    const on = editable.filter((el) => el.getAttribute('spellcheck') !== 'false');
    expect(on.map((el) => el.dataset.cellKey ?? el.className)).toEqual([]);
  });

  it('renders no stray text into the grid', () => {
    // `//` inside an html`` template is markup, not a comment.
    mount();
    expect(host.textContent).not.toContain('//');
    expect(host.textContent).not.toContain('spellchecker');
  });
});

describe('part-aware completion', () => {
  it('narrows on the part under the caret, not the whole cell', () => {
    // Typing the second half of "1SG.NO" must narrow to NOM, not to nothing.
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.NO');
    expect(altsValues()).toEqual(['NOM']);
  });

  it('replaces only that part on a pick, and leaves the caret after it', () => {
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.NO');
    editor._pickAlt(cell, { value: 'NOM', source: 'tagset' });
    expect(cell.value).toBe('1SG.NOM');
    expect(cell.selectionStart).toBe(7);
  });

  it('does not commit a part pick: the value is still being built', () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan');
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.NO');
    editor._pickAlt(cell, { value: 'NOM', source: 'tagset' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('replaces the whole cell when the tagset has no delimiters', () => {
    mount({ ...LEIPZIG, delimiters: '' });
    const cell = glossCell();
    focus(cell);
    type(cell, 'anything');
    editor._pickAlt(cell, { value: 'PL', source: 'tagset' });
    expect(cell.value).toBe('PL');
  });
});

describe('an off-tagset value that was never typed', () => {
  it('renders with the invalid squiggle whatever wrote it', async () => {
    // Violations are computed from the STORED value on every render, so a
    // token merge folding `dog` and `PL` into `dog | PL`, an import, a service
    // or the assistant all get flagged the same way. Typing is the ONLY path
    // that cannot reach here, because commit refuses first.
    const doc = mount();
    const cell = glossCell();
    const morphId = cell.dataset.cellKey.split(':')[1];
    await doc.updateMorphemeSpan(morphId, 'Gloss', 'dog | PL', null);
    await flush();
    expect(glossCell().classList.contains('igt-field--invalid')).toBe(true);
  });
});

describe('who owns Enter while the picker is open', () => {
  // Enter is preventDefault-ed either way once the picker declines, because
  // normal Enter handling (commit, move to the next cell) claims it. So assert
  // on what the cell ENDS UP holding, not on who consumed the event.
  const key = (el, k) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('leaves the typed text alone when nothing matches', async () => {
    mount({ ...LEIPZIG, mode: 'suggest' });
    const cell = glossCell();
    focus(cell);
    type(cell, 'zzz');
    key(cell, 'Enter');
    expect(cell.value).toBe('zzz');
  });

  it('keeps the typed text on a SUGGESTING tagset rather than taking the highlighted row', async () => {
    // "N" is a legal new value there, and silently turning it into NOM would
    // be the picker overruling the user.
    mount({ ...LEIPZIG, mode: 'suggest' });
    const cell = glossCell();
    focus(cell);
    type(cell, 'N');
    key(cell, 'Enter');
    expect(cell.value).toBe('N');
  });

  it('takes the row on an ENFORCING tagset, where the typed prefix is not legal', async () => {
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, 'N');
    key(cell, 'Enter');
    expect(cell.value).toBe('NOM');
  });

  it('commits a value already typed in full, instead of picking it again', async () => {
    // Closed + delimiters: the filter is the part under the caret, so typing
    // NOM in full leaves NOM highlighted. Picking it is a no-op, and in part
    // mode a pick deliberately does not commit — so Enter did nothing at all
    // and the value needed a second Enter to save.
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.NOM');
    key(cell, 'Enter');
    await flush();
    // Assert on what was WRITTEN: a successful Enter also navigates, and the
    // re-render then shows the doc's value, which the mocked write never set.
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe('1SG.NOM');
  });

  it('takes the row once the user has arrowed to it, whatever the mode', async () => {
    mount({ ...LEIPZIG, mode: 'suggest' });
    const cell = glossCell();
    focus(cell);
    type(cell, 'N');
    key(cell, 'ArrowDown');
    key(cell, 'Enter');
    expect(cell.value).not.toBe('N');
  });
});

describe('commit', () => {
  it('writes a value the tagset allows', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.PL');
    await blur(cell);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe('1SG.PL');
  });

  it('refuses one it does not, and keeps what was typed', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan');
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.ABL');
    await blur(cell);
    expect(spy).not.toHaveBeenCalled();
    // Rejected, not reverted: the value is wrong but it is the user's.
    expect(cell.value).toBe('1SG.ABL');
  });

  it('accepts a lexical gloss under mixed, which is what makes closed usable', async () => {
    // A stem's cell holds `dog`. Under plain `closed` that is refused, and no
    // gloss tagset could ever be closed.
    const doc = mount({ ...LEIPZIG, mode: 'mixed' });
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'dog.PL');
    await blur(cell);
    expect(spy).toHaveBeenCalled();
  });

  it('still refuses an unlisted grammatical tag under mixed', async () => {
    const doc = mount({ ...LEIPZIG, mode: 'mixed' });
    const spy = vi.spyOn(doc, 'updateMorphemeSpan');
    const cell = glossCell();
    focus(cell);
    type(cell, 'dog.ABL');
    await blur(cell);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses nothing when the tagset only suggests', async () => {
    const doc = mount({ ...LEIPZIG, mode: 'suggest' });
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'whatever');
    await blur(cell);
    expect(spy).toHaveBeenCalled();
  });

  it('squiggles the cell it just refused, so it cannot read as saved', async () => {
    // No render happens after a refusal, so without this the cell keeps the
    // typed value with no mark on it and looks committed.
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.ABL');
    await blur(cell);
    expect(cell.classList.contains('igt-field--invalid')).toBe(true);
  });

  it('always allows clearing a cell, which is how an annotation is deleted', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    cell.dataset.orig = 'PL';
    cell.value = 'PL';
    focus(cell);
    type(cell, '');
    cell.dataset.orig = 'PL';
    await blur(cell);
    expect(spy).toHaveBeenCalled();
  });
});

// Two morphemes sharing one form, glossed differently, so the form's ranked
// list does NOT start with the cell's own value. With unique forms (the
// fixture's default) every cell tops its own list, and a wrong pick is
// invisible because it picks the value already there.
const twoSharingAForm = async (doc, g0, g1) => {
  const ids = [...host.querySelectorAll('input[data-cell-key^="ma:"]')].map(
    (c) => c.dataset.cellKey.split(':')[1],
  );
  await doc.updateMorphemeForm(ids[0], 'xx');
  await doc.updateMorphemeForm(ids[1], 'xx');
  await doc.updateMorphemeSpan(ids[0], 'Gloss', g0, null);
  await doc.updateMorphemeSpan(ids[1], 'Gloss', g1, null);
  await flush();
};
const key = (el, k) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('Enter on an untouched governed cell', () => {
  // The list opens on focus, so Enter reaches the picker on every plain
  // "commit and move on". On an enforcing tagset it used to take the top row,
  // which is the form's most frequent gloss — not this cell's value.
  it('keeps the stored value rather than taking the top of the list', async () => {
    const doc = mount({ ...LEIPZIG, delimiters: '' });
    await twoSharingAForm(doc, 'PL', 'NOM');
    const cell = glossCell();
    expect(cell.value).toBe('PL');
    focus(cell);
    expect(editor._alts.visible[0].value).not.toBe('PL');
    key(cell, 'Enter');
    await flush();
    expect(glossCell().value).toBe('PL');
  });

  it('keeps a composite value whole in part mode', async () => {
    // Focus select-alls, so the caret sits at 0 and the "part under the caret"
    // is the FIRST part: 1SG.NOM became ABL.NOM.
    const doc = mount({ ...LEIPZIG, values: [...LEIPZIG.values, { value: 'ABL' }] });
    await twoSharingAForm(doc, '1SG.NOM', 'ABL.ABL');
    const cell = glossCell();
    focus(cell);
    key(cell, 'Enter');
    await flush();
    expect(glossCell().value).toBe('1SG.NOM');
  });

  it('moves on to the next cell, as Enter does everywhere else', async () => {
    const doc = mount({ ...LEIPZIG, delimiters: '' });
    await twoSharingAForm(doc, 'PL', 'PL');
    const cell = glossCell();
    focus(cell);
    key(cell, 'Enter');
    await flush();
    expect(document.activeElement).not.toBe(glossCell());
  });
});

describe('a pick from the keyboard', () => {
  it('commits and moves on in whole-value mode', async () => {
    const doc = mount({ ...LEIPZIG, delimiters: '' });
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'N');
    key(cell, 'Enter');
    await flush();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe('NOM');
    expect(document.activeElement).not.toBe(glossCell());
  });

  it('stays in the cell in part mode, and the NEXT Enter commits', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, '1SG.NO');
    key(cell, 'Enter');
    expect(cell.value).toBe('1SG.NOM');
    expect(spy).not.toHaveBeenCalled();
    expect(altsList()).toBeNull();
    key(cell, 'Enter');
    await flush();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe('1SG.NOM');
  });

  it('typing the next delimiter reopens the list for the next part', async () => {
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, '1S');
    key(cell, 'Enter');
    expect(cell.value).toBe('1SG');
    expect(altsList()).toBeNull();
    type(cell, '1SG.');
    expect(altsList()).not.toBeNull();
  });

  it('a typed part that is already legal is committed, not re-picked', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'NOM');
    key(cell, 'Enter');
    await flush();
    expect(spy).toHaveBeenCalled();
  });
});

describe('a pick with the mouse', () => {
  it('does not reopen the list over the value just chosen', async () => {
    mount({ ...LEIPZIG, delimiters: '' });
    const cell = glossCell();
    focus(cell);
    expect(altsList()).not.toBeNull();
    editor._pickAlt(cell, { value: 'PL', source: 'tagset' });
    await flush();
    expect(altsList()).toBeNull();
  });
});

describe('after a refusal', () => {
  it('Escape puts the SAVED value back, not the refused one', async () => {
    const doc = mount();
    const cell0 = glossCell();
    const morphId = cell0.dataset.cellKey.split(':')[1];
    await doc.updateMorphemeSpan(morphId, 'Gloss', 'PL', null);
    await flush();
    const cell = glossCell();
    focus(cell);
    type(cell, 'ABL');
    await blur(cell);
    await flush(); // the refocus microtask
    expect(cell.value).toBe('ABL');
    expect(cell.dataset.orig).toBe('PL');
    key(cell, 'Escape');
    expect(cell.value).toBe('PL');
  });

  it('a corrected value commits', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'ABL');
    await blur(cell);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    type(cell, 'PL');
    await blur(cell);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][2]).toBe('PL');
  });

  it('leaving again with the same refused text is refused again, not silently dropped', async () => {
    const doc = mount();
    const spy = vi.spyOn(doc, 'updateMorphemeSpan').mockResolvedValue(true);
    const cell = glossCell();
    focus(cell);
    type(cell, 'ABL');
    await blur(cell);
    await flush();
    await blur(cell);
    expect(spy).not.toHaveBeenCalled();
    expect(cell.classList.contains('igt-field--invalid')).toBe(true);
  });
});

describe('a governed sentence field', () => {
  it('carries the enforces flag like a grid cell', () => {
    const raw = buildRawDoc();
    const client = makeFakeClient();
    client.query = async () => ({ results: [] });
    const sentenceLayer = raw.textLayers[0].tokenLayers
      .flatMap((tl) => tl.spanLayers || [])
      .find((sl) => sl.id === 'ssl-0');
    sentenceLayer.config.igt.tagset = 'Leipzig';
    const doc = new IgtDocument({
      raw,
      project: projectWith({ ...LEIPZIG, delimiters: '' }),
      vocabularies: {},
      client,
      projectId: 'proj-1',
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new IgtEditor(host, doc, {});
    const ta = host.querySelector('textarea[data-has-tagset]');
    expect(ta).not.toBeNull();
    expect(ta.dataset.tagsetEnforces).toBe('1');
  });
});

describe('Escape on a governed cell', () => {
  it('reverts and leaves in one press when the list opened on its own', async () => {
    // The list opens on focus, so Escape used to need two presses: one to
    // close a list the user never asked for, one to revert the cell.
    const doc = mount({ ...LEIPZIG, delimiters: '' });
    const morphId = glossCell().dataset.cellKey.split(':')[1];
    await doc.updateMorphemeSpan(morphId, 'Gloss', 'PL', null);
    await flush();
    const cell = glossCell();
    focus(cell);
    expect(altsList()).not.toBeNull();
    key(cell, 'Escape');
    expect(altsList()).toBeNull();
    expect(document.activeElement).not.toBe(cell);
    expect(cell.value).toBe('PL');
  });

  it('only closes the list mid-completion, keeping what was typed', () => {
    mount();
    const cell = glossCell();
    focus(cell);
    type(cell, 'N');
    key(cell, 'Escape');
    expect(altsList()).toBeNull();
    expect(document.activeElement).toBe(cell);
    expect(cell.value).toBe('N');
  });
});
