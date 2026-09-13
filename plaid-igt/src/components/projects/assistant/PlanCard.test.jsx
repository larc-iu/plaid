import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { PlanCard } from '@ui/components/assistant/PlanCard.jsx';
import { IGT_ASSISTANT } from './adapter.js';

// A plan that rewrites the baseline says so before it is approved.
//
// A stress-test agent approved a plan headed "1 text edit, 1 field value"
// whose first line was "Retype sentence 1 (drops the trailing period, standard
// for IGT baselines)". Their own transcription lost a period they had typed,
// and four other sentences kept theirs. A text edit counted as one more line
// of the same thing as a gloss, which is what made it approvable unread, so
// the card now separates the two.

const at = (sentence) => ({
  kind: 'token',
  documentId: 'd1',
  documentName: 'Text 1',
  sentenceId: `s-${sentence}`,
  sentence,
  word: null,
  morpheme: null,
  begin: 0,
  surface: 'Los niños jugaban en el parque',
});

const gloss = (i) => ({
  label: `Text 1 s${i}.w1: Gloss = "x"`,
  where: { ...at(i), word: 1 },
  change: 'Gloss = "x"',
  writesText: false,
});

const retype = {
  label: 'Text 1 s1: retype "Los niños jugaban." → "Los niños jugaban"',
  where: at(1),
  change: 'retype "Los niños jugaban." → "Los niños jugaban"',
  writesText: true,
};

const render = (changes, extra = {}) =>
  renderComponent(
    <PlanCard
      plan={{
        id: 'p1',
        summary: '1 text edit, 1 field value',
        labels: changes.map((c) => c.label),
        ops: changes.map(() => ({})),
        changes,
      }}
      status={null}
      canWrite
      projectId="p"
      adapter={IGT_ASSISTANT}
      onApprove={() => {}}
      onDiscard={() => {}}
      {...extra}
    />,
  );

describe('PlanCard and a change to the baseline', () => {
  it('counts the rewrites apart from the rest, in this app’s words', async () => {
    const { container, unmount } = await render([gloss(2), retype]);
    expect(container.textContent).toContain('1 change rewrites your baseline text.');
    await unmount();
  });

  it('marks the row itself, not just the count', async () => {
    const { container, unmount } = await render([gloss(2), retype]);
    const marked = [...container.querySelectorAll('tr')].filter((tr) =>
      tr.textContent.includes('Rewrite'),
    );
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('retype');
    await unmount();
  });

  it('says nothing when the plan only annotates', async () => {
    const { container, unmount } = await render([gloss(1), gloss(2)]);
    expect(container.textContent).not.toContain('rewrites');
    expect(container.textContent).not.toContain('Rewrite');
    await unmount();
  });

  it('shows the rewrite even when the plan is too long to show whole', async () => {
    // Buried at the end of 30 glosses, it was behind "Show all" before.
    const many = Array.from({ length: 30 }, (_, i) => gloss(i + 2));
    const { container, unmount } = await render([...many, retype]);
    expect(container.textContent).toContain('Show all 31');
    const marked = [...container.querySelectorAll('tr')].filter((tr) =>
      tr.textContent.includes('Rewrite'),
    );
    expect(marked).toHaveLength(1);
    await unmount();
  });

  it('pluralizes the count', async () => {
    const { container, unmount } = await render([
      retype,
      { ...retype, label: 'Text 1 s3: retype', where: at(3) },
    ]);
    expect(container.textContent).toContain('2 changes rewrite your baseline text.');
    await unmount();
  });
});
