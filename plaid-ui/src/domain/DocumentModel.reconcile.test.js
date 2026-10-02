// A repair on open refused because the document moved on (two pages opening
// one document at once, the other page's repair landing first) reads the
// document again and repairs once more, so the page shows the repaired
// document rather than the one it read before the other page's repair.
import { describe, it, expect, vi } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

const conflict = () => Object.assign(new Error('Conflict'), { status: 409 });

const client = {
  withOperation: (label, fn) => fn(() => {}),
};

const docWith = (answers) => {
  class Repairing extends DocumentModel {
    async _reconcile() {
      this.passes = (this.passes ?? 0) + 1;
      return answers.shift();
    }
  }
  const doc = new Repairing({ raw: { id: 'd1', name: 'One', metadata: {} }, client });
  doc._reload = vi.fn(async () => {});
  return doc;
};

describe('a repair on open refused as changed elsewhere', () => {
  it('reads the document again and repairs once more', async () => {
    const doc = docWith([
      { findings: [], error: conflict() },
      { findings: [], repaired: true },
    ]);
    const result = await doc.reconcileOnOpen();
    expect(doc._reload).toHaveBeenCalledTimes(1);
    expect(doc.passes).toBe(2);
    expect(result).toEqual({ findings: [], repaired: true });
  });

  it('tries again only once', async () => {
    const second = conflict();
    const doc = docWith([
      { findings: [], error: conflict() },
      { findings: [], error: second },
    ]);
    const result = await doc.reconcileOnOpen();
    expect(doc.passes).toBe(2);
    expect(result.error).toBe(second);
  });

  it('does not try again after another refusal', async () => {
    const refused = Object.assign(new Error('Forbidden'), { status: 403 });
    const doc = docWith([{ findings: [], error: refused }]);
    const result = await doc.reconcileOnOpen();
    expect(doc._reload).not.toHaveBeenCalled();
    expect(doc.passes).toBe(1);
    expect(result.error).toBe(refused);
  });

  it('keeps the first answer when the document cannot be read again', async () => {
    const first = conflict();
    const doc = docWith([{ findings: [], error: first }]);
    doc._reload = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await doc.reconcileOnOpen();
    expect(doc.passes).toBe(1);
    expect(result.error).toBe(first);
  });
});
