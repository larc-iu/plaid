import { describe, it, expect } from 'vitest';
import { createOnce } from './createOnce.js';

const lost = () => Object.assign(new Error('HTTP 504'), { status: 504, method: 'POST' });
const taken = (id) =>
  Object.assign(new Error('HTTP 409 id-taken'), {
    status: 409,
    method: 'POST',
    responseData: { error: 'id-taken', 'id-taken': true, id },
  });

describe('createOnce', () => {
  it('sends the same id on a second press after a lost answer, and opens what the first made', async () => {
    const ref = { current: null };
    const sent = [];
    await expect(
      createOnce(ref, async (id) => {
        sent.push(id);
        throw lost();
      }),
    ).rejects.toThrow('504');
    const made = await createOnce(ref, async (id) => {
      sent.push(id);
      throw taken(id);
    });
    expect(sent[0]).toBe(sent[1]);
    expect(made).toEqual({ id: sent[0] });
    expect(ref.current).toBe(null);
  });

  it('mints a new id once a create succeeded', async () => {
    const ref = { current: null };
    const a = await createOnce(ref, async (id) => ({ id, name: 'A' }));
    const b = await createOnce(ref, async (id) => ({ id, name: 'B' }));
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('a refusal of another kind is thrown and the id kept', async () => {
    const ref = { current: null };
    const conflict = Object.assign(new Error('HTTP 409'), { status: 409, method: 'POST' });
    await expect(createOnce(ref, async () => Promise.reject(conflict))).rejects.toBe(conflict);
    expect(ref.current).toMatch(/^[0-9a-f-]{36}$/);
  });
});
