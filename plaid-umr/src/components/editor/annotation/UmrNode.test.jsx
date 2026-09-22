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
const position = { x: 100, y: 10, width: 120, height: 40 };

// A triple with this node at one end, as docTagsOf hands it over.
const tag = (id, rel, otherVar, { out = false, group = 'coref', isDefault = false } = {}) => ({
  id,
  rel,
  group,
  otherVar,
  isDefault,
  source: out ? 'n1' : `x${id}`,
  target: out ? `x${id}` : 'n1',
  text: out ? `${rel} ${otherVar}` : `${otherVar} ${rel}`,
});

// A pointer-down on the node records it as focused, which a part's click
// then reads.
const pressAndClick = async (r, el) =>
  r.step(() => {
    r.container
      .querySelector('.umr-node')
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el.click();
  });

describe('UmrNode document tags', () => {
  it('marks which end of the triple the node is', async () => {
    const tags = [
      tag('a', ':before', 's3b', { out: true, group: 'temporal' }),
      tag('b', ':full-affirmative', 'author', { group: 'modal', isDefault: true }),
    ];
    const r = await renderComponent(<UmrNode node={node} position={position} docTags={tags} />);
    expect(texts(r.container, '.umr-doc-tag')).toEqual([
      '● :before s3b',
      'author :full-affirmative ●',
    ]);
    const [temporal, modal] = all(r.container, '.umr-doc-tag');
    expect(temporal.dataset.group).toBe('temporal');
    expect(modal.hasAttribute('data-default')).toBe(true);
    await r.unmount();
  });

  it('merges the triples of one relation and direction into one tag', async () => {
    const onDocTagClick = vi.fn();
    const tags = [
      tag('a', ':full-affirmative', 's3b', { group: 'modal' }),
      tag('b', ':full-affirmative', 's3m', { group: 'modal' }),
      tag('c', ':same-entity', 's1p'),
    ];
    const r = await renderComponent(
      <UmrNode
        node={node}
        position={position}
        docTags={tags}
        focused
        onAction={() => {}}
        onDocTagClick={onDocTagClick}
      />,
    );
    expect(texts(r.container, '.umr-doc-tag')).toEqual([
      's3b s3m :full-affirmative ●',
      's1p :same-entity ●',
    ]);
    // Each end of the merged tag is its own click.
    const second = r.container.querySelector('.umr-doc-tag-end[data-triple-id="b"]');
    await pressAndClick(r, second);
    expect(onDocTagClick).toHaveBeenCalledWith(tags[1]);
    await r.unmount();
  });

  // The node 26 others are a subset of: one tag, three of the ends and a
  // count of the rest, which lists them all once the node is focused.
  it('caps the ends one tag lists', async () => {
    const onAction = vi.fn();
    const tags = Array.from({ length: 26 }, (_, i) => tag(`t${i}`, ':subset-of', `s${i + 3}x`));
    const r = await renderComponent(
      <UmrNode node={node} position={position} docTags={tags} focused onAction={onAction} />,
    );
    expect(texts(r.container, '.umr-doc-tag')).toEqual(['s3x s4x s5x +23 :subset-of ●']);
    const more = r.container.querySelector('.umr-doc-more');
    expect(more.title.split('\n')).toHaveLength(23);
    await pressAndClick(r, more);
    expect(onAction).toHaveBeenCalledWith('node.docRelations', 'n1');
    await r.unmount();
  });

  it('shows five tags, and past five four and a count', async () => {
    const rels = [':before', ':after', ':overlap', ':contains', ':depends-on', ':contained'];
    const five = rels.slice(0, 5).map((rel, i) => tag(`t${i}`, rel, `s${i}e`, { out: true }));
    let r = await renderComponent(<UmrNode node={node} position={position} docTags={five} />);
    expect(all(r.container, '.umr-doc-tag')).toHaveLength(5);
    expect(all(r.container, '.umr-doc-more')).toHaveLength(0);
    await r.unmount();

    const six = rels.map((rel, i) => tag(`t${i}`, rel, `s${i}e`, { out: true }));
    r = await renderComponent(<UmrNode node={node} position={position} docTags={six} />);
    expect(texts(r.container, '.umr-doc-tag')).toEqual([
      '● :before s0e',
      '● :after s1e',
      '● :overlap s2e',
      '● :contains s3e',
      '+2',
    ]);
    await r.unmount();
  });
});

describe('UmrNode provenance', () => {
  const withMeta = (metadata) => ({ ...node, metadata });

  it('tints a machine-drafted node and a contributor', async () => {
    let r = await renderComponent(
      <UmrNode
        node={withMeta({ prov: 'inferred', provSource: 'service:umr-draft-llm' })}
        position={position}
      />,
    );
    let box = r.container.querySelector('.umr-node');
    expect(box.classList.contains('umr-node--machine')).toBe(true);
    expect(box.dataset.prov).toBe('machine');
    expect(box.title).toBe('Machine-made, unverified');
    await r.unmount();

    r = await renderComponent(
      <UmrNode
        node={withMeta({ prov: 'contributed', provSource: 'user:a@b.com' })}
        position={position}
      />,
    );
    box = r.container.querySelector('.umr-node');
    expect(box.classList.contains('umr-node--contributed')).toBe(true);
    await r.unmount();
  });

  it('draws a settled node plain, confirmed or hand-made', async () => {
    for (const metadata of [
      null,
      { prov: 'inferred', provSource: 'service:umr-draft-llm', provConfirmed: true },
    ]) {
      const r = await renderComponent(<UmrNode node={withMeta(metadata)} position={position} />);
      const box = r.container.querySelector('.umr-node');
      expect(box.className).not.toMatch(/umr-node--(machine|contributed)/);
      expect(box.hasAttribute('data-prov')).toBe(false);
      expect(box.hasAttribute('title')).toBe(false);
      await r.unmount();
    }
  });
});
