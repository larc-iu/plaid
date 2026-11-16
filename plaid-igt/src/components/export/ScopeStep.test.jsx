import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ScopeStep } from './ScopeStep.jsx';

describe('ScopeStep', () => {
  it('lists the documents to choose by name in number order', async () => {
    // Core lists them in plain string order, which files "(10)" before "(2)".
    const documents = ['(1) One', '(10) Ten', '(2) Two', 'Text 10', 'Text 2'].map((name, i) => ({
      id: `d${i}`,
      name,
    }));
    const { container, unmount } = await renderComponent(
      <ScopeStep
        scope="documents"
        onScopeChange={() => {}}
        documents={documents}
        selectedDocIds={new Set()}
        onSelectedDocIdsChange={() => {}}
      />,
    );
    const listed = [...container.querySelectorAll('input[type="checkbox"]')].map((box) =>
      box.closest('label').textContent.trim(),
    );
    expect(listed).toEqual(['(1) One', '(2) Two', '(10) Ten', 'Text 2', 'Text 10']);
    await unmount();
  });
});
