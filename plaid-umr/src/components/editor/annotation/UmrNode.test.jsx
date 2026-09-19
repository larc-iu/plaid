import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { UmrNode } from './UmrNode.jsx';

const node = {
  id: 'n1',
  var: 's2t',
  concept: 'thing',
  attrs: [],
  aligned: true,
  constant: false,
};
const tags = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    rel: ':subset-of',
    group: 'coref',
    text: `s${i + 3}x :subset-of`,
  }));
const position = { x: 100, y: 10, width: 120, height: 40 };

describe('UmrNode document tags', () => {
  it('wears five tags as they are', async () => {
    const r = await renderComponent(<UmrNode node={node} position={position} docTags={tags(5)} />);
    expect(all(r.container, '.umr-doc-tag')).toHaveLength(5);
    expect(all(r.container, '.umr-doc-tag--more')).toHaveLength(0);
    await r.unmount();
  });

  // The node 26 others are a subset of: four tags and a count, which names
  // the rest in its tooltip and, once the node is focused, lists them all.
  it('past five, four and a count of the rest', async () => {
    const onAction = vi.fn();
    const r = await renderComponent(
      <UmrNode node={node} position={position} docTags={tags(26)} focused onAction={onAction} />,
    );
    expect(texts(r.container, '.umr-doc-tag')).toEqual([
      's3x :subset-of',
      's4x :subset-of',
      's5x :subset-of',
      's6x :subset-of',
      '+22',
    ]);
    const more = r.container.querySelector('.umr-doc-tag--more');
    expect(more.title.split('\n')).toHaveLength(22);
    await r.step(() => {
      r.container
        .querySelector('.umr-node')
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
      more.click();
    });
    expect(onAction).toHaveBeenCalledWith('node.docRelations', 'n1');
    await r.unmount();
  });
});
