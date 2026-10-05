// The run dialog has a Close in its footer, so the corner button is named
// for what it closes, and a screen reader hears two different buttons.
import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { ServiceRunDialog } from './ServiceRunDialog.jsx';

describe('ServiceRunDialog', () => {
  it('names its two close buttons apart', async () => {
    const view = await renderComponent(
      <ServiceRunDialog
        open
        onOpenChange={() => {}}
        title="Tokenize"
        runLabel="Tokenize"
        onRun={() => {}}
      />,
    );
    const names = [...document.body.querySelectorAll('[role=dialog] button')]
      .map((b) => b.textContent.trim())
      .filter((t) => t.startsWith('Close'));
    expect(names.sort()).toEqual(['Close', 'Close Tokenize']);
    await view.unmount();
  });
});
