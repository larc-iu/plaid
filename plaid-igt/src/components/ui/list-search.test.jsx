import { describe, it, expect } from 'vitest';
import { renderComponent } from '@/test/renderComponent';
import { ListCount } from './list-search';

// The count sits beside every search box in the app, so its noun agreement is
// visible on more screens than any other string.
describe('ListCount', () => {
  const text = async (props) => {
    const { container, unmount } = await renderComponent(<ListCount {...props} />);
    const value = container.textContent;
    await unmount();
    return value;
  };

  it('drops the "of" when nothing is filtered out', async () => {
    expect(await text({ shown: 7, total: 7, noun: 'account' })).toBe('7 accounts');
  });

  it('says how much a search is hiding', async () => {
    expect(await text({ shown: 2, total: 7, noun: 'account' })).toBe('2 of 7 accounts');
  });

  it('leaves a singular alone', async () => {
    expect(await text({ shown: 1, total: 1, noun: 'account' })).toBe('1 account');
  });

  it('handles a -y noun', async () => {
    expect(await text({ shown: 3, total: 3, noun: 'vocabulary' })).toBe('3 vocabularies');
  });

  it('knows the irregulars a list has needed', async () => {
    expect(await text({ shown: 7, total: 7, noun: 'person' })).toBe('7 people');
    expect(await text({ shown: 1, total: 1, noun: 'person' })).toBe('1 person');
  });

  it('does not invent irregulars it was not taught', async () => {
    expect(await text({ shown: 2, total: 2, noun: 'service' })).toBe('2 services');
  });

  it('groups thousands', async () => {
    expect(await text({ shown: 1234, total: 1234, noun: 'change' })).toBe('1,234 changes');
  });
});
