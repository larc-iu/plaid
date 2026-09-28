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

  it('opens a tag on the first click, the node not yet focused', async () => {
    const onDocTagClick = vi.fn();
    const tags = [tag('a', ':before', 's9p', { group: 'temporal' })];
    const r = await renderComponent(
      <UmrNode
        node={node}
        position={position}
        docTags={tags}
        onAction={() => {}}
        onDocTagClick={onDocTagClick}
      />,
    );
    await r.step(() => r.container.querySelector('.umr-doc-tag').click());
    expect(onDocTagClick).toHaveBeenCalledWith(tags[0]);
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

  it('marks a machine-drafted node and a contributor', async () => {
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

  // Plain, and a confirmed node's tooltip still names where it came from, in
  // igt's words.
  it('draws a settled node plain, confirmed or hand-made', async () => {
    for (const [metadata, title] of [
      [null, null],
      [
        { prov: 'inferred', provSource: 'service:umr-draft-llm', provConfirmed: true },
        'Machine-suggested, confirmed',
      ],
      [
        { prov: 'contributed', provSource: 'user:a@b.com', provConfirmed: true },
        'Contributed, confirmed',
      ],
    ]) {
      const r = await renderComponent(<UmrNode node={withMeta(metadata)} position={position} />);
      const box = r.container.querySelector('.umr-node');
      expect(box.className).not.toMatch(/umr-node--(machine|contributed)/);
      expect(box.hasAttribute('data-prov')).toBe(false);
      expect(box.getAttribute('title')).toBe(title);
      await r.unmount();
    }
  });
});

// What a screen reader hears, as CANVAS.md specified: the node, where it
// hangs, its problems, and names for the controls inside it.
describe('UmrNode names', () => {
  const name = (r) => r.container.querySelector('.umr-node').getAttribute('aria-label');

  it('names the node with its parent and relation, or as the root', async () => {
    let r = await renderComponent(
      <UmrNode node={node} position={position} parent="ARG0 of leave-02" />,
    );
    expect(name(r)).toBe('s2t thing, ARG0 of leave-02');
    await r.unmount();
    r = await renderComponent(<UmrNode node={{ ...node, root: true }} position={position} />);
    expect(name(r)).toBe('s2t thing, root');
    await r.unmount();
  });

  it('counts its problems', async () => {
    const problems = [
      { level: 'error', message: 'a' },
      { level: 'error', message: 'b' },
      { level: 'warning', message: 'c' },
    ];
    const r = await renderComponent(
      <UmrNode node={node} position={position} parent="mod of city" problems={problems} />,
    );
    expect(name(r)).toBe('s2t thing, mod of city, 2 errors, 1 warning');
    await r.unmount();
  });

  it('names the menu button for its node, and the chain chip for what it does', async () => {
    const r = await renderComponent(
      <UmrNode
        node={node}
        position={position}
        onMenu={() => {}}
        chain={{ index: 0, color: 'blue', size: 3 }}
      />,
    );
    expect(r.container.querySelector('.umr-more').getAttribute('aria-label')).toBe(
      'Actions for s2t',
    );
    expect(r.container.querySelector('.umr-chain').getAttribute('aria-label')).toBe(
      'Next mention in coreference chain 1, 3 mentions',
    );
    await r.unmount();
  });

  it("says a tag's dot as this node, in the order the relation runs", async () => {
    const tags = [
      tag('a', ':before', 's3b', { out: true, group: 'temporal' }),
      tag('b', ':full-affirmative', 'author', { group: 'modal' }),
      tag('c', ':same-entity', 's1p'),
      tag('d', ':same-entity', 's4p'),
    ];
    const r = await renderComponent(
      <UmrNode node={node} position={position} docTags={tags} onDocTagClick={() => {}} />,
    );
    expect(all(r.container, '.umr-doc-tag').map((t) => t.getAttribute('aria-label'))).toEqual([
      'this node :before s3b',
      'author :full-affirmative this node',
      's1p s4p :same-entity this node',
    ]);
    expect(all(r.container, '.umr-doc-tag').map((t) => t.getAttribute('role'))).toEqual([
      'button',
      'button',
      'group',
    ]);
    // The dot itself is not read.
    const dots = all(r.container, '.umr-doc-tag [aria-hidden="true"]');
    expect(dots.map((d) => d.textContent)).toEqual(['●', '●', '●']);
    await r.unmount();
  });
});
