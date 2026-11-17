import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { MarkedText } from './MarkedText.jsx';

// An excerpt sits in an English row beside "#1" and the document's name, so
// it isolates its own direction: an Arabic sentence keeps its full stop at its
// end, on the left.

describe('an excerpt with its hits marked', () => {
  it('isolates its direction, with or without marks', async () => {
    for (const marks of [[], [{ begin: 0, end: 3 }]]) {
      const view = await renderComponent(<MarkedText text="قرأ الولد الكتاب." marks={marks} />);
      const bdi = view.container.querySelector('bdi');
      expect(bdi?.getAttribute('dir')).toBe('rtl');
      expect(bdi.textContent).toBe('قرأ الولد الكتاب.');
      await view.unmount();
    }
  });

  it('takes the direction most of its letters read in, not its first word', async () => {
    for (const [text, dir] of [
      ['CNN قالت إن الاقتصاد ينمو.', 'rtl'],
      ['قال he would come tomorrow.', 'ltr'],
    ]) {
      for (const marks of [[], [{ begin: 0, end: 3 }]]) {
        const view = await renderComponent(<MarkedText text={text} marks={marks} />);
        expect(view.container.querySelector('bdi')?.getAttribute('dir')).toBe(dir);
        await view.unmount();
      }
    }
  });

  it('is set in the face for language data, and a hit in the shared highlight', async () => {
    const view = await renderComponent(
      <MarkedText text="Ваз хъсан чида" marks={[{ begin: 4, end: 9 }]} />,
    );
    expect(view.container.querySelector('bdi').className).toContain('font-text');
    expect(view.container.querySelector('mark').className).toContain('bg-highlight');
    await view.unmount();
  });

  it('marks the hit by code points', async () => {
    const view = await renderComponent(<MarkedText text="a😀bc" marks={[{ begin: 1, end: 3 }]} />);
    expect(view.container.querySelector('mark').textContent).toBe('😀b');
    await view.unmount();
  });
});

// The dictionary's concordance picks a morpheme out inside its word: a mark
// may carry `inner`, ranges in the same sentence offsets, drawn as a stronger
// stretch of the same highlight inside the word's. Every other caller passes
// none and gets exactly what it got before.
describe('a mark with a stretch inside it', () => {
  const html = async (marks) => {
    const view = await renderComponent(<MarkedText text="Jesus Messiahnguuq ." marks={marks} />);
    const out = view.container.innerHTML;
    await view.unmount();
    return out;
  };

  it('draws a mark with no inner stretch exactly as before', async () => {
    const plain = await html([{ begin: 6, end: 18 }]);
    expect(await html([{ begin: 6, end: 18, inner: [] }])).toBe(plain);
    expect(plain).toBe(
      '<bdi dir="ltr" class="font-text">Jesus <mark class="rounded-sm bg-highlight px-0.5 text-foreground">Messiahnguuq</mark> .</bdi>',
    );
  });

  it('sets the inner stretch in its own element inside the mark, not a second mark', async () => {
    const view = await renderComponent(
      <MarkedText
        text="Jesus Messiahnguuq ."
        marks={[{ begin: 6, end: 18, inner: [{ begin: 13, end: 16 }] }]}
      />,
    );
    const marks = view.container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('Messiahnguuq');
    const inner = marks[0].querySelectorAll('span');
    expect(inner).toHaveLength(1);
    expect(inner[0].textContent).toBe('ngu');
    expect(inner[0].className).toContain('bg-highlight-strong');
    expect(inner[0].className).toContain('font-semibold');
    // Nothing for a screen reader to announce: the word reads whole.
    expect(inner[0].getAttribute('role')).toBeNull();
    expect(inner[0].getAttribute('aria-label')).toBeNull();
    await view.unmount();
  });

  it('draws two stretches in one word, each on its own', async () => {
    const view = await renderComponent(
      <MarkedText
        text="pingunguq"
        marks={[
          {
            begin: 0,
            end: 9,
            inner: [
              { begin: 2, end: 5 },
              { begin: 5, end: 8 },
            ],
          },
        ]}
      />,
    );
    const mark = view.container.querySelector('mark');
    expect([...mark.querySelectorAll('span')].map((s) => s.textContent)).toEqual(['ngu', 'ngu']);
    expect(mark.textContent).toBe('pingunguq');
    await view.unmount();
  });

  it('counts the inner stretch in code points', async () => {
    const view = await renderComponent(
      <MarkedText text="𐌰𐌺ngu x" marks={[{ begin: 0, end: 5, inner: [{ begin: 2, end: 5 }] }]} />,
    );
    expect(view.container.querySelector('mark span').textContent).toBe('ngu');
    await view.unmount();
  });

  it('clamps an inner stretch to its mark, and drops one outside it', async () => {
    const view = await renderComponent(
      <MarkedText
        text="ab cdefg hi"
        marks={[
          {
            begin: 3,
            end: 8,
            inner: [
              { begin: 0, end: 2 },
              { begin: 1, end: 5 },
              { begin: 7, end: 40 },
            ],
          },
        ]}
      />,
    );
    const mark = view.container.querySelector('mark');
    expect(mark.textContent).toBe('cdefg');
    expect([...mark.querySelectorAll('span')].map((s) => s.textContent)).toEqual(['cd', 'g']);
    expect(view.container.textContent).toBe('ab cdefg hi');
    await view.unmount();
  });
});
