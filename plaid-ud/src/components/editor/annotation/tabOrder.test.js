// Tab walks the grid row by row through `data-tab-order`, and leaves the page's
// own Tab order (header, tabs, toolbars) to the browser.
import { describe, it, expect, afterEach } from 'vitest';
import { routeGridTab } from './tabOrder.js';

let host;
afterEach(() => host?.remove());

// Two tokens, DOM order column by column as the grid draws it, walk order row
// by row: lemma(the)=1 lemma(dog)=2 upos(the)=3 upos(dog)=4.
const grid = () => {
  host = document.createElement('div');
  host.innerHTML = `
    <button id="toolbar">Accept</button>
    <div class="col"><input id="l0" data-tab-order="1"><input id="u0" data-tab-order="3"></div>
    <div class="col"><input id="l1" data-tab-order="2"><input id="u1" data-tab-order="4"></div>`;
  document.body.appendChild(host);
  host.addEventListener('keydown', routeGridTab);
  return host;
};

const tab = (id, shiftKey = false) => {
  const el = document.getElementById(id);
  el.focus();
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
};

describe('routeGridTab', () => {
  it('moves along the row, then to the start of the next row', () => {
    grid();
    tab('l0');
    expect(document.activeElement.id).toBe('l1');
    tab('l1');
    expect(document.activeElement.id).toBe('u0');
  });

  it('moves back with Shift+Tab', () => {
    grid();
    tab('u0', true);
    expect(document.activeElement.id).toBe('l1');
  });

  it('leaves the key to the browser past either end', () => {
    grid();
    expect(tab('u1').defaultPrevented).toBe(false);
    expect(tab('l0', true).defaultPrevented).toBe(false);
  });

  it('ignores a key some cell already took, and keys outside the grid', () => {
    grid();
    expect(tab('toolbar').defaultPrevented).toBe(false);
    const el = document.getElementById('l0');
    el.focus();
    el.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement.id).toBe('l0');
  });
});
