import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useConfigCell } from './useConfigCell.js';
import { sameConfig, storedConfig, expectStored } from '../domain/configCells.js';

// A page that writes one config cell several times names, on each write, what
// it expects the cell to hold: its own last write, until it reads the cell
// again. Two writes sent at once would both expect the value before either.

const mount = async (stored) => {
  const seen = { current: null };
  const Probe = ({ value }) => {
    seen.current = useConfigCell(value);
    return null;
  };
  const r = await renderComponent(<Probe value={stored} />);
  return { ...r, Probe, cell: () => seen.current };
};

describe('useConfigCell', () => {
  it('expects what the page read, then what it wrote, then what it read again', async () => {
    const read = { a: 1 };
    const r = await mount(read);
    expect(r.cell().expected()).toBe(read);
    const sent = [];
    await r.cell().write(async (expected) => {
      sent.push(expected);
      return { a: 2 };
    });
    expect(r.cell().expected()).toEqual({ a: 2 });
    const reread = { a: 3 };
    await r.rerender(<r.Probe value={reread} />);
    expect(r.cell().expected()).toBe(reread);
    expect(sent).toEqual([read]);
    await r.unmount();
  });

  it('sends a second write after the first has settled, expecting what the first stored', async () => {
    const r = await mount(null);
    let release;
    const held = new Promise((res) => (release = res));
    const sent = [];
    const first = r.cell().write(async (expected) => {
      sent.push(expected);
      await held;
      return 'one';
    });
    const second = r.cell().write(async (expected) => {
      sent.push(expected);
      return 'two';
    });
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual([null, 'one']);
    await r.unmount();
  });

  it('keeps the expected value when a write is refused', async () => {
    const r = await mount('x');
    await expect(
      r.cell().write(async () => {
        throw new Error('HTTP 409');
      }),
    ).rejects.toThrow();
    expect(r.cell().expected()).toBe('x');
    // And the next write still goes out.
    await r.cell().write(async () => 'y');
    expect(r.cell().expected()).toBe('y');
    await r.unmount();
  });
});

describe('configCells', () => {
  it('compares config values the way the server does', () => {
    expect(sameConfig({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(sameConfig([1, 2], [2, 1])).toBe(false);
    expect(sameConfig(undefined, null)).toBe(true);
    expect(sameConfig({}, null)).toBe(false);
  });

  it('reads a cell off a project or layer', () => {
    const layer = { config: { ud: { vocab: ['X'] } } };
    expect(storedConfig(layer, 'ud', 'vocab')).toEqual(['X']);
    expect(storedConfig(layer, 'igt', 'vocab')).toBeUndefined();
    expect(expectStored(layer, 'ud', 'vocabMode')).toEqual({ expected: undefined });
  });
});
