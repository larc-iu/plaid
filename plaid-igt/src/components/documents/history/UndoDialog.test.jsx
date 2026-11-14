import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ROLES } from '@larc-iu/plaid-client';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';

// Undo one History entry. The dialog asks core for a dry run first and says,
// before anything is written, what would be undone and what would be left and
// why, then undoes on one button. Driven here by canned answers of
// audit.undo, one per state the dialog has.

const feedback = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('@/utils/feedback', () => feedback);

const { UndoDialog } = await import('./UndoDialog.jsx');

const counts = (n, how = 'updated') => ({ inserted: 0, updated: 0, deleted: 0, [how]: n });
const answer = (undone = {}, skipped = [], extra = {}) => ({
  entry: 'e1',
  dryRun: true,
  undone,
  total: 0,
  rows: 0,
  skipped,
  skippedCount: skipped.length,
  notUndone: [],
  ...extra,
});
const httpError = (status, responseData = {}) =>
  Object.assign(new Error(`HTTP ${status} x at http://x/y`), { status, responseData });

// Every reason core gives, one row each, in sentences 1 and 2 of the document.
const EVERY_REASON = [
  ['changed-since', {}],
  ['changed-between', {}],
  ['built-on', { by: { kind: 'span', id: 'x' } }],
  ['needs', { needs: { kind: 'token', id: 't' } }],
  ['text-changed-since', {}],
  ['place-taken', {}],
  ['not-permitted', {}],
  ['locked', {}],
  ['name-taken', {}],
  ['does-not-fit', {}],
  ['value-not-allowed', {}],
  ['not-undone', {}],
].map(([reason, extra], i) => ({ kind: 'span', id: `r${i}`, document: 'd1', reason, ...extra }));

const place = (row) =>
  row.id === 'gone'
    ? null
    : {
        key: row.id === 'r0' ? 's-2' : 's-1',
        label: row.id === 'r0' ? 'Sentence 2' : 'Sentence 1',
        to: `/projects/p1/documents/d1?tab=analyze&focusSentence=${row.id === 'r0' ? 's-2' : 's-1'}`,
      };

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});
beforeEach(() => {
  for (const f of Object.values(feedback)) f.mockReset();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
};

const mount = async (undo, props = {}) => {
  const onOpenChange = vi.fn();
  const onUndone = vi.fn().mockResolvedValue(undefined);
  view = await renderComponent(
    <MemoryRouter>
      <UndoDialog
        open
        onOpenChange={onOpenChange}
        client={{ audit: { undo } }}
        entry={{ id: 'e1', label: 'Gloss of "kai" in sentence 1: go', time: 't' }}
        scope={{ documentId: 'd1' }}
        place={place}
        onUndone={onUndone}
        {...props}
      />
    </MemoryRouter>,
  );
  await settle();
  return { onOpenChange, onUndone };
};

const dialog = () => document.body.querySelector('[data-testid="undo-dialog"]');
const text = () => dialog().textContent;
const buttons = () => all(dialog(), 'button').map((b) => b.textContent.trim());
const button = (label) => all(dialog(), 'button').find((b) => b.textContent.trim() === label);
const press = (el) =>
  view.step(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

describe('UndoDialog', () => {
  it('asks for a dry run of this document’s rows and says what would be undone', async () => {
    const undo = vi.fn().mockResolvedValue(
      answer({
        spans: counts(12),
        tokens: counts(2, 'deleted'),
        vocabItems: counts(2, 'inserted'),
        vocabLinks: counts(5),
      }),
    );
    await mount(undo, {
      tokenRows: [
        { id: 'w1', role: ROLES.WORD },
        { id: 'm1', role: ROLES.MORPHEME },
      ],
    });
    expect(undo).toHaveBeenCalledWith('e1', {
      dryRun: true,
      documentId: 'd1',
      vocabLayerId: undefined,
    });
    expect(byText(dialog(), 'h2', 'Undo this entry?')).not.toBeNull();
    expect(text()).toContain('Gloss of "kai" in sentence 1: go');
    expect(dialog().querySelector('[data-testid="undo-line"]').textContent).toBe(
      '12 values, 1 word, 1 morpheme, 5 links and 2 lexicon entries brought back',
    );
    expect(dialog().querySelector('[data-testid="undo-left"]')).toBeNull();
    expect(buttons()).toEqual(expect.arrayContaining(['Cancel', 'Undo']));
    expect(button('Undo').disabled).toBe(false);
  });

  it('says it is comparing until the dry run answers', async () => {
    await mount(vi.fn(() => new Promise(() => {})));
    expect(text()).toContain('Comparing…');
    expect(button('Undo').disabled).toBe(true);
  });

  it('lists what would be left, every reason in plain words, each a list of places', async () => {
    const undo = vi
      .fn()
      .mockResolvedValue(
        answer({ spans: counts(1) }, [
          ...EVERY_REASON,
          { kind: 'span', id: 'gone', document: 'd1', reason: 'changed-since' },
          { kind: 'span', id: 'z', document: 'd1', reason: 'reason-from-the-future' },
        ]),
      );
    await mount(undo);
    const groups = all(dialog(), '[data-reason]');
    expect(groups.map((g) => g.querySelector('summary').textContent)).toEqual([
      'Changed again later2',
      'Changed by someone else during the entry1',
      'Something was added to it since1',
      'Needs something not brought back1',
      'Text changed since1',
      'Its place is taken1',
      'Not permitted1',
      'Document locked by someone else1',
      'Name taken by another document1',
      'Would not fit the document1',
      'Value no longer allowed1',
      'Vocabulary name and settings1',
      'reason-from-the-future1',
    ]);
    // A group opens on the places its rows are, each a link where it can be
    // shown.
    const changed = groups[0];
    expect(changed.querySelector('details').open).toBe(false);
    await view.step(() => {
      changed.querySelector('details').open = true;
    });
    const places = all(changed, '[data-place]');
    expect(places.map((p) => p.textContent)).toEqual(['Sentence 21 change', 'Elsewhere1 change']);
    expect(places[0].querySelector('a').getAttribute('href')).toBe(
      '/projects/p1/documents/d1?tab=analyze&focusSentence=s-2',
    );
    expect(places[1].querySelector('a')).toBeNull();
    expect(button('Undo').disabled).toBe(false);
  });

  it('says what is never undone', async () => {
    const undo = vi.fn().mockResolvedValue(
      answer({ spans: counts(1) }, [], {
        notUndone: [
          { opType: 'project/update', count: 1 },
          { opType: 'span-layer/update', count: 1 },
        ],
      }),
    );
    await mount(undo);
    expect(text()).toContain('Project settings are not undone.');
    expect(text()).toContain('Fields and their settings are not undone.');
  });

  it('says so and offers only Close when nothing would be undone', async () => {
    const undo = vi
      .fn()
      .mockResolvedValue(
        answer({ spans: counts(0) }, [
          { kind: 'span', id: 'r0', document: 'd1', reason: 'changed-since' },
        ]),
      );
    const { onOpenChange } = await mount(undo);
    expect(text()).toContain('Nothing to undo.');
    expect(text()).toContain('Changed again later');
    expect(dialog().querySelector('[data-testid="undo-line"]')).toBeNull();
    expect(button('Undo')).toBeUndefined();
    expect(button('Cancel')).toBeUndefined();
    await press(button('Close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('says where the entries the entry changed are undone, with their links', async () => {
    const undo = vi.fn().mockResolvedValue(
      answer({ spans: counts(0) }, [
        {
          kind: 'vocab-link',
          id: 'l1',
          document: 'd1',
          reason: 'needs',
          needs: { kind: 'vocab-item', id: 'kay' },
        },
      ]),
    );
    await mount(undo, { vocabularies: [{ id: 'v1', name: 'Story lexicon' }] });
    const note = dialog().querySelector('[data-testid="undo-entries-note"]');
    expect(note.textContent).toBe(
      'Lexicon entries are undone from the vocabulary’s History, with every link to them: Story lexicon',
    );
    expect(note.querySelector('a').getAttribute('href')).toBe('/vocabularies/v1?history=e1');
    await view.unmount();
    // Nothing of a vocabulary's, nothing said.
    await mount(vi.fn().mockResolvedValue(answer({ spans: counts(1) })));
    expect(dialog().querySelector('[data-testid="undo-entries-note"]')).toBeNull();
  });

  it.each([
    [413, {}, 'Too many changes to undo. An undo takes at most 20,000.'],
    [422, {}, 'A project’s deletion cannot be undone.'],
    [403, {}, 'Only a maintainer can undo this entry.'],
    [403, { unresolved: true }, 'This entry does not exist or cannot be opened.'],
  ])('says the refusal %i in its own sentence, with only Close', async (status, data, said) => {
    await mount(vi.fn().mockRejectedValue(httpError(status, data)));
    expect(text()).toContain(said);
    expect(buttons()).toContain('Close');
    expect(button('Undo')).toBeUndefined();
  });

  it('undoes, cannot be dismissed meanwhile, then says what it did and reads again', async () => {
    let finish;
    const undo = vi
      .fn()
      .mockResolvedValueOnce(
        answer({ spans: counts(3) }, [
          { kind: 'span', id: 'r0', document: 'd1', reason: 'changed-since' },
        ]),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const { onOpenChange, onUndone } = await mount(undo);
    await press(button('Undo'));
    expect(undo).toHaveBeenLastCalledWith('e1', { documentId: 'd1', vocabLayerId: undefined });
    expect(button('Undoing…').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    // Escape, the close button: nothing lets go while it runs.
    await view.step(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await press(all(dialog(), 'button').find((b) => b.textContent.trim() === 'Close'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog().querySelector('[inert]')).not.toBeNull();

    await view.step(async () => {
      finish(
        answer({ spans: counts(3) }, [
          { kind: 'span', id: 'r0', document: 'd1', reason: 'changed-since' },
        ]),
      );
    });
    await settle();
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '3 values. 1 change left as it was.',
      'Undone',
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it('says a refused undo, reads the page again and asks again', async () => {
    const undo = vi
      .fn()
      .mockResolvedValueOnce(answer({ spans: counts(1) }))
      .mockRejectedValueOnce(httpError(413))
      .mockResolvedValueOnce(answer({ spans: counts(1) }));
    const { onUndone } = await mount(undo);
    await press(button('Undo'));
    await settle();
    expect(feedback.notifyError).toHaveBeenCalledWith(
      'Too many changes to undo. An undo takes at most 20,000.',
      'Failed to undo',
    );
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(3);
    expect(undo.mock.calls[2][1].dryRun).toBe(true);
  });

  it('titles a call that undid nothing as such', async () => {
    // Someone wrote between the dry run and the call.
    const undo = vi
      .fn()
      .mockResolvedValueOnce(answer({ spans: counts(1) }))
      .mockResolvedValueOnce(
        answer({}, [{ kind: 'span', id: 'r0', document: 'd1', reason: 'changed-since' }]),
      );
    await mount(undo);
    await press(button('Undo'));
    await settle();
    expect(feedback.notifySuccess).not.toHaveBeenCalled();
    expect(feedback.notifyInfo).toHaveBeenCalledWith('1 change left as it was.', 'Nothing undone');
  });

  it('says an undo whose answer was lost may have been made, and goes back to now', async () => {
    const lost = Object.assign(new Error('HTTP 0 network at http://x/y'), {
      status: 0,
      method: 'POST',
    });
    const undo = vi
      .fn()
      .mockResolvedValueOnce(answer({ spans: counts(1) }))
      .mockRejectedValueOnce(lost);
    const { onOpenChange, onUndone } = await mount(undo);
    await press(button('Undo'));
    await settle();
    expect(feedback.notifyWarning).toHaveBeenCalledWith(
      'The server did not answer. The undo may have been made. History shows whether it was.',
      'Not confirmed',
    );
    expect(feedback.notifyError).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onUndone).toHaveBeenCalledTimes(1);
    // No fresh dry run, whose "Nothing to undo" would read the undo's own
    // writes as changed since.
    expect(undo).toHaveBeenCalledTimes(2);
  });

  it('counts what is left truly when core lists only the first rows', async () => {
    const skipped = [
      ...Array.from({ length: 600 }, (_, i) => ({
        kind: 'span',
        id: `c${i}`,
        document: 'd1',
        reason: 'changed-since',
      })),
      ...Array.from({ length: 400 }, (_, i) => ({
        kind: 'span',
        id: `b${i}`,
        document: 'd1',
        reason: 'built-on',
      })),
    ];
    await mount(
      vi.fn().mockResolvedValue({ ...answer({ spans: counts(1) }, skipped), skippedCount: 2500 }),
    );
    const left = dialog().querySelector('[data-testid="undo-left"]');
    expect(left.querySelector('p').textContent).toBe('Left as they are2,500');
    expect(all(left, 'summary').map((x) => x.textContent)).toEqual([
      'Changed again later600 listed',
      'Something was added to it since400 listed',
    ]);
    expect(left.querySelector('[data-testid="undo-unlisted"]').textContent).toBe(
      '1,500 more not listed.',
    );
  });

  it('indents the places on the side the text starts', async () => {
    await mount(
      vi
        .fn()
        .mockResolvedValue(
          answer({}, [{ kind: 'span', id: 'r0', document: 'd1', reason: 'changed-since' }]),
        ),
    );
    const list = dialog().querySelector('[data-reason] details ul');
    expect(list.className).toContain('ms-5');
    expect(dialog().innerHTML).not.toMatch(/\b(ml|mr|pl|pr)-\d/);
  });

  it('names an action inside an entry as one', async () => {
    await mount(vi.fn().mockResolvedValue(answer({ spans: counts(1) })), {
      entry: { id: 'op1', label: 'Set a gloss', action: true },
    });
    expect(byText(dialog(), 'h2', 'Undo this action?')).not.toBeNull();
  });
});
