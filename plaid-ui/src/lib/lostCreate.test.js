import { describe, it, expect } from 'vitest';
import { findLostCreate } from './lostCreate.js';

// A create whose answer was lost is looked for before Create is offered again.

const lost = () =>
  Object.assign(new Error('Request timed out at http://x/api/v1/documents'), {
    status: 0,
    method: 'POST',
    url: 'http://x/api/v1/documents',
  });

const before = [
  { id: 'a', name: 'Story' },
  { id: 'b', name: 'Other' },
];

describe('findLostCreate', () => {
  it('finds the row the create made, not one of the same name that was there before', async () => {
    const made = await findLostCreate(lost(), {
      before,
      reread: async () => [...before, { id: 'c', name: 'Story' }],
      isIt: (row) => row.name === 'Story',
    });
    expect(made).toEqual({ id: 'c', name: 'Story' });
  });

  it('is null when the create made nothing', async () => {
    const made = await findLostCreate(lost(), {
      before,
      reread: async () => before,
      isIt: (row) => row.name === 'Story',
    });
    expect(made).toBe(null);
  });

  it('does not read again for a refusal, whose outcome is known', async () => {
    let reads = 0;
    const refused = Object.assign(new Error('HTTP 500 boom'), { status: 500, method: 'POST' });
    const made = await findLostCreate(refused, {
      before,
      reread: async () => {
        reads += 1;
        return [];
      },
      isIt: () => true,
    });
    expect(made).toBe(null);
    expect(reads).toBe(0);
  });

  it('is null when the list cannot be read either', async () => {
    const made = await findLostCreate(lost(), {
      before,
      reread: async () => {
        throw new Error('Network error: Failed to fetch');
      },
      isIt: () => true,
    });
    expect(made).toBe(null);
  });
});

describe('findLostCreate without the list from before', () => {
  it('does not guess, since a row of that name may have been there already', async () => {
    const made = await findLostCreate(lost(), {
      before: null,
      reread: async () => [{ id: 'a', name: 'Story' }],
      isIt: (row) => row.name === 'Story',
    });
    expect(made).toBe(null);
  });
});
