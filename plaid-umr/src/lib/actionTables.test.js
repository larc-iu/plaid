// The canvas's three tables of node actions, held against each other.
//
// An action lives in `keymap.js` (which key reaches it), in `NodeMenu.jsx`
// (which menu row reaches it) and in `SentenceBlock`'s `runAction` (what it
// does). Nothing used to compare them, so a row added to one and forgotten
// in another was a bound key that did nothing, or a menu row that did
// nothing, and neither says so on screen.
//
// `runAction` is read from the source, since it is a switch inside a
// component: what is being held is the list of `case` labels.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS_ACTIONS, KEY_ACTIONS } from './keymap.js';
import { ITEMS } from '../components/editor/annotation/nodeMenuItems.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENTENCE_BLOCK = path.join(
  HERE,
  '..',
  'components',
  'editor',
  'annotation',
  'SentenceBlock.jsx',
);

const source = () => fs.readFileSync(SENTENCE_BLOCK, 'utf8');

// From `const runAction = ...` to the line that closes its switch: the whole
// body, which is what both the case list and the focus check read.
const runActionBody = () => {
  const text = source();
  const from = text.indexOf('const runAction = async (');
  return text.slice(from, text.indexOf('\n  };', from));
};

const runActionCases = () =>
  new Set([...runActionBody().matchAll(/^\s*case '([\w.]+)':/gm)].map((m) => m[1]));

const menuIds = ITEMS.flat().map(([id]) => id);

// Reached from the node's `+N` chip rather than from a key or the menu: the
// node's other document-level relations, listed so one can be changed.
const NOT_IN_A_TABLE = new Set(['node.docRelations']);

describe('the canvas action tables agree', () => {
  it('every action a key reaches is a runAction case', () => {
    const cases = runActionCases();
    expect(CANVAS_ACTIONS.length).toBeGreaterThan(10);
    expect(CANVAS_ACTIONS.filter((id) => !cases.has(id))).toEqual([]);
  });

  it('every menu row is a runAction case', () => {
    const cases = runActionCases();
    expect(menuIds.length).toBeGreaterThan(10);
    expect(menuIds.filter((id) => !cases.has(id))).toEqual([]);
  });

  it('every runAction case is reachable by a key or the menu', () => {
    const reachable = new Set([...CANVAS_ACTIONS, ...menuIds, ...NOT_IN_A_TABLE]);
    expect([...runActionCases()].filter((id) => !reachable.has(id))).toEqual([]);
  });

  it('every node action with a key is on the menu, so the menu teaches it', () => {
    const onMenu = new Set(menuIds);
    const nodeKeys = CANVAS_ACTIONS.filter((id) => id.startsWith('node.'));
    expect(nodeKeys.filter((id) => !onMenu.has(id))).toEqual([]);
  });

  // The comment over `runAction` promises "one definition, so a gesture
  // cannot come to mean two things depending on which way it was reached".
  // The two delete actions used to read the focus behind its back, which
  // held only because every route to them focuses first.
  it('runAction acts on the node it was given, never on the focus', () => {
    const body = runActionBody();
    const [signature, ...rest] = body.split('\n');
    expect(signature).toMatch(/id = focusedId/);
    expect(rest.join('\n')).not.toMatch(/focusedId/);
  });

  it('every key the menu prints is a row of the keymap', () => {
    const known = new Set(KEY_ACTIONS.map((a) => a.id));
    const printed = ITEMS.flat()
      .map(([, , keyId]) => keyId)
      .filter(Boolean);
    expect(printed.filter((id) => !known.has(id))).toEqual([]);
    // And an action with no explicit key id is looked up by its own.
    const implicit = ITEMS.flat()
      .filter(([, , keyId]) => !keyId)
      .map(([id]) => id);
    expect(implicit.filter((id) => !known.has(id))).toEqual([]);
  });
});
