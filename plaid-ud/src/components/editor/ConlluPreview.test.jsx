import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ConlluPreview } from './ConlluPreview.jsx';

// The Export tab's preview of the file. On an Arabic row the FORM and LEMMA,
// with only a tab between them, would form one right-to-left run and the
// lemma would be drawn first. Each field of such a row is isolated, so the
// columns keep the file's order on every row.

const FILE = [
  '# sent_id = ar1',
  '# text = وقال الرئيس إن الاقتصاد ينمو.',
  '1-2\tوقال\t_\t_\t_\t_\t_\t_\t_\t_',
  '5\tالاقتصاد\tاِقتِصَاد\tNOUN\tN------S4D\tCase=Acc\t6\tnsubj\t6:obl:ب\t_',
  '',
  '1\tde\tde\tADP\tSP\t_\t2\tcase\t2:case\t_',
  '#שלום',
].join('\n');

const mount = () => renderComponent(<ConlluPreview content={FILE} />);

describe('the CoNLL-U preview', () => {
  it('shows the file exactly, read-only, left to right and unwrapped', async () => {
    const { container, unmount } = await mount();
    expect(all(container, 'textarea').length).toBe(0);
    const pre = container.querySelector('pre');
    expect(pre.textContent).toBe(FILE);
    expect(pre.getAttribute('dir')).toBe('ltr');
    expect(pre.className).toContain('whitespace-pre');
    expect(pre.className).toContain('overflow-auto');
    await unmount();
  });

  it('isolates every field of a row with right-to-left text, in the file order', async () => {
    const { container, unmount } = await mount();
    const rows = all(container, '.conllu-row');
    const fields = [...rows[3].querySelectorAll('bdi')].map((b) => b.textContent);
    expect(fields).toEqual(FILE.split('\n')[3].split('\t'));
    await unmount();
  });

  it("isolates a comment's value, so its full stop stays at its own end", async () => {
    const { container, unmount } = await mount();
    const bdis = all(container, '.conllu-row')[1].querySelectorAll('bdi');
    expect(bdis.length).toBe(1);
    expect(bdis[0].textContent).toBe('وقال الرئيس إن الاقتصاد ينمو.');
    await unmount();
  });

  it('draws right-to-left fields out of the monospace, and leaves the rest in it', async () => {
    const { container, unmount } = await mount();
    const bdis = [...all(container, '.conllu-row')[3].querySelectorAll('bdi')];
    expect(bdis[1].className).toBe('font-sans');
    expect(bdis[0].className).toBe('');
    expect(bdis[3].className).toBe('');
    await unmount();
  });

  it('leaves a row of plain ASCII as plain text', async () => {
    const { container, unmount } = await mount();
    const rows = all(container, '.conllu-row');
    expect(rows[5].querySelectorAll('bdi').length).toBe(0);
    expect(rows[0].querySelectorAll('bdi').length).toBe(0);
    await unmount();
  });
});

describe('a comment with no key', () => {
  it('keeps its text exactly and isolates what follows the #', async () => {
    const { container, unmount } = await mount();
    const last = all(container, '.conllu-row')[6];
    expect(last.textContent).toBe('#שלום');
    expect(last.querySelector('bdi').textContent).toBe('שלום');
    await unmount();
  });
});
