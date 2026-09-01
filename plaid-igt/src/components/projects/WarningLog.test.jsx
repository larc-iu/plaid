import { describe, it, expect, vi } from 'vitest';
import { renderComponent, texts, byText } from '@/test/renderComponent.jsx';
import { WarningLog } from './ImportElanProject.jsx';

const entry = (text, document = null) => ({ text, document });

describe('WarningLog', () => {
  it('groups consecutive warnings under the document that raised them', async () => {
    const { container, unmount } = await renderComponent(
      <WarningLog
        log={[
          entry('Media files are not imported.'),
          entry('Utterance 1: something odd.', 'a.eaf'),
          entry('Utterance 2: something else.', 'a.eaf'),
          entry('Utterance 1: a third thing.', 'b.eaf'),
        ]}
      />,
    );
    // A corpus-wide warning is labelled as such rather than attributed to a file.
    expect(texts(container, 'p')).toContain('The corpus as a whole');
    expect(texts(container, 'p')).toContain('a.eaf');
    expect(texts(container, 'p')).toContain('b.eaf');
    // One list per document, not one per warning.
    expect(container.querySelectorAll('ul').length).toBe(3);
    expect(texts(container, 'li')).toEqual([
      'Media files are not imported.',
      'Utterance 1: something odd.',
      'Utterance 2: something else.',
      'Utterance 1: a third thing.',
    ]);
    await unmount();
  });

  it('counts every warning in the title, including ones it does not draw', async () => {
    const log = Array.from({ length: 250 }, (_, i) => entry(`Warning ${i + 1}.`, 'big.eaf'));
    const { container, unmount } = await renderComponent(<WarningLog log={log} />);
    expect(byText(container, 'p', '250 warnings')).not.toBeNull();
    // Capped, because one node per warning is a wall and a cost.
    expect(container.querySelectorAll('li').length).toBe(200);
    expect(byText(container, 'p', 'and 50 more, which Copy includes')).not.toBeNull();
    await unmount();
  });

  it('copies the whole log, not only the part on screen', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const log = Array.from({ length: 250 }, (_, i) => entry(`Warning ${i + 1}.`, 'big.eaf'));
    const { container, step, unmount } = await renderComponent(<WarningLog log={log} />);
    await step(() => byText(container, 'button', 'Copy').click());
    const copied = writeText.mock.calls[0][0];
    expect(copied.split('\n')).toHaveLength(250);
    expect(copied).toContain('Warning 250.');
    expect(copied.startsWith('big.eaf\tWarning 1.')).toBe(true);
    vi.unstubAllGlobals();
    await unmount();
  });

  it('says "1 warning", not "1 warnings"', async () => {
    const { container, unmount } = await renderComponent(
      <WarningLog log={[entry('Just the one.')]} />,
    );
    expect(byText(container, 'p', '1 warning')).not.toBeNull();
    expect(byText(container, 'p', '1 warnings')).toBeNull();
    await unmount();
  });
});
