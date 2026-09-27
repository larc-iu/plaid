// The review gesture has one name in every app (idiom ruling 05): Accept, as
// on the sentence's "Accept graph" pill. The key's label and the node menu's
// row are what a person reads for the same gesture on one node.
import { describe, it, expect } from 'vitest';
import { KEY_ACTIONS } from './keymap.js';
import { ITEMS } from '../components/editor/annotation/nodeMenuItems.js';

describe('the review gesture on a node', () => {
  it('is called Accept in the keymap and on the node menu', () => {
    const action = KEY_ACTIONS.find((a) => a.id === 'node.confirm');
    expect(action.label).toMatch(/^Accept /);
    const row = ITEMS.flat().find(([id]) => id === 'node.confirm');
    expect(row[1]).toBe('Accept');
  });

  it('is never called Confirm on either', () => {
    const labels = [...KEY_ACTIONS.map((a) => a.label), ...ITEMS.flat().map(([, label]) => label)];
    expect(labels.filter((l) => /\bconfirm/i.test(l))).toEqual([]);
  });
});
