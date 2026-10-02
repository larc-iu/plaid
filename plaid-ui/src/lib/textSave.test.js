import { describe, it, expect, vi } from 'vitest';
import { sendTextPlan } from './textSave.js';

const refusal = (status, data = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, method: 'POST', responseData: data });

// A save whose sends answer in turn from `answers` (an Error is thrown).
const saveOf = (answers, { stored = { body: 'x' }, holds = false, sentBefore = false } = {}) => {
  const save = {
    prepare: vi.fn(async () => true),
    send: vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    sentBefore: () => sentBefore,
    readStored: vi.fn(async () => stored),
    holds: vi.fn(() => holds),
    replan: vi.fn(async () => {}),
    conflict: 'Changed elsewhere',
  };
  return save;
};

describe('sendTextPlan', () => {
  it('answers what the send answered', async () => {
    const save = saveOf([{ digest: 'd' }]);
    expect(await sendTextPlan(save)).toEqual({ answer: { digest: 'd' } });
  });

  it('throws a lost answer to the queue, reading nothing', async () => {
    const lost = refusal(502);
    const save = saveOf([lost]);
    await expect(sendTextPlan(save)).rejects.toBe(lost);
    expect(save.readStored).not.toHaveBeenCalled();
  });

  it('plans a first send refused as changed again on a fresh read, up to twice', async () => {
    const save = saveOf([refusal(409), refusal(409), { ok: 1 }]);
    expect(await sendTextPlan(save)).toEqual({ answer: { ok: 1 } });
    expect(save.replan).toHaveBeenCalledTimes(2);
    expect(save.replan).toHaveBeenCalledWith(null);
    expect(save.readStored).not.toHaveBeenCalled();
    const thrice = refusal(409);
    const again = saveOf([refusal(409), refusal(409), thrice]);
    await expect(sendTextPlan(again)).rejects.toBe(thrice);
  });

  it('finds a send made before stored when the text holds it', async () => {
    const stored = { body: 'done' };
    const save = saveOf([refusal(409)], { sentBefore: true, holds: true, stored });
    expect(await sendTextPlan(save)).toEqual({ stored });
    expect(save.holds).toHaveBeenCalledWith(stored);
  });

  it('reads back any other refusal, which may have landed', async () => {
    const save = saveOf([refusal(500)], { holds: true });
    expect(await sendTextPlan(save)).toEqual({ stored: { body: 'x' } });
    const refused = refusal(500);
    const not = saveOf([refused]);
    await expect(sendTextPlan(not)).rejects.toBe(refused);
  });

  it('says a key reused for another request is a conflict', async () => {
    const save = saveOf([refusal(422, { error: 'idempotency-key-reused' })]);
    await expect(sendTextPlan(save)).rejects.toThrow('Changed elsewhere');
  });

  it('plans a text changed after a send made before again on what it read', async () => {
    const stored = { body: 'theirs' };
    const save = saveOf([refusal(409), { ok: 1 }], { sentBefore: true, stored });
    expect(await sendTextPlan(save)).toEqual({ answer: { ok: 1 } });
    expect(save.replan).toHaveBeenCalledWith(stored);
  });

  it('throws what planning throws, and answers nothing when there is nothing to send', async () => {
    const save = saveOf([refusal(409)]);
    const conflict = Object.assign(new Error('same passage'), { status: 409 });
    save.prepare = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(conflict);
    await expect(sendTextPlan(save)).rejects.toBe(conflict);
    expect(save.send).toHaveBeenCalledTimes(1);
    const none = saveOf([]);
    none.prepare = async () => false;
    expect(await sendTextPlan(none)).toEqual({ nothing: true });
    expect(none.send).not.toHaveBeenCalled();
  });

  it('leaves a refusal as it is when the read fails', async () => {
    const refused = refusal(500);
    const save = saveOf([refused]);
    save.readStored = async () => {
      throw new Error('offline');
    };
    await expect(sendTextPlan(save)).rejects.toBe(refused);
  });
});
