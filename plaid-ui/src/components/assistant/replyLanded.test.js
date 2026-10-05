import { describe, it, expect } from 'vitest';
import { replyLanded } from './replyLanded.js';

const waiting = { busy: 'turn', id: 'c1', length: 1 };
const now = (display, over = {}) => ({ busy: null, id: 'c1', display, ...over });
const asked = { kind: 'user', text: 'gloss it' };
const reply = { kind: 'assistant', text: 'Done.' };

describe('replyLanded', () => {
  it('is true once a waited-for reply is in', () => {
    expect(replyLanded(waiting, now([asked, reply]))).toBe(true);
  });

  it('is false while the turn runs, after an error, or for another conversation', () => {
    expect(replyLanded(waiting, now([asked, reply], { busy: 'turn' }))).toBe(false);
    expect(replyLanded(waiting, now([asked, { kind: 'error' }]))).toBe(false);
    expect(replyLanded(waiting, now([asked, reply], { id: 'c2' }))).toBe(false);
  });

  it('is false when nothing was waiting, or nothing was added', () => {
    expect(replyLanded({ busy: null, id: 'c1', length: 1 }, now([asked, reply]))).toBe(false);
    expect(replyLanded(waiting, now([asked]))).toBe(false);
    expect(replyLanded({ busy: 'apply', id: 'c1', length: 1 }, now([asked, reply]))).toBe(false);
  });
});
