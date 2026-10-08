import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';
import { storedIgnoredTokens } from '@/domain/igtConfig';

// Typing in the ignored-tokens lists saves as it goes. A key typed while the
// last key's save is still out used to lose characters twice over: the later
// save checked the store against what the page showed when the key was
// typed, older than what the earlier save wrote, and was refused as "Changed
// elsewhere", and the project read back after a save put its older list into
// the box over what had been typed since (H9-NUM-3). Every key now lands.

const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const input = (c, placeholder) =>
  all(c, 'input').find((i) => (i.placeholder || '').includes(placeholder));

const FIELDS = [{ name: 'Gloss', scope: 'Word', isCustom: false }];

// The settings page as FieldsSettings drives it: a save refuses a list the
// store no longer holds as `previous` (queueRest), takes a moment, and the
// project read back after it hands the manager fresh initial data.
const mountPage = async (ignoredTokens, { saveMs = 80, countMs = 5 } = {}) => {
  const server = { ignoredTokens: storedIgnoredTokens(ignoredTokens) };
  const refused = [];
  let reload;
  const onSaveChanges = vi.fn(async ({ ignoredTokens: next, previous }) => {
    // The page reads the project, compares, then writes with the value it
    // read as `expected`, which the server checks again (a 409 if it moved).
    await sleep(saveMs / 2);
    const read = JSON.stringify(server.ignoredTokens);
    const sent = storedIgnoredTokens(next);
    const refuse = () => {
      refused.push(sent);
      throw Object.assign(new Error('Changed elsewhere'), { status: 409 });
    };
    if (read !== JSON.stringify(sent)) {
      if (read !== JSON.stringify(storedIgnoredTokens(previous.ignoredTokens))) refuse();
      await sleep(saveMs / 2);
      if (JSON.stringify(server.ignoredTokens) !== read) refuse();
      server.ignoredTokens = sent;
    }
    reload();
  });
  const onCountHiddenWords = vi.fn(async () => {
    await sleep(countMs);
    return 0;
  });
  const Page = () => {
    const [data, setData] = useState({ fields: FIELDS, ignoredTokens });
    reload = () =>
      setData({
        fields: FIELDS,
        ignoredTokens: {
          ...ignoredTokens,
          explicitIgnoredTokens: server.ignoredTokens.blacklist || [],
          unicodePunctuationExceptions: server.ignoredTokens.whitelist || [],
        },
      });
    return (
      <FieldsManager
        initialData={data}
        onSaveChanges={onSaveChanges}
        onCountHiddenWords={onCountHiddenWords}
        onError={() => {}}
        projectId="p1"
      />
    );
  };
  const r = await renderComponent(<Page />);
  return { ...r, server, refused };
};

// Type `text` one key at a time, `ms` apart, the way a person does.
const typeKeys = async ({ step }, box, text, ms) => {
  for (let i = 1; i <= text.length; i++) {
    await step(async () => typeInto(box(), text.slice(0, i)));
    await step(() => sleep(ms));
  }
  await step(() => sleep(400));
};

const EXPLICIT = {
  mode: 'explicit-list',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: [],
};
const PUNCT = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: [],
};

describe('typing faster than a save in the ignored-tokens lists', () => {
  for (const ms of [0, 10, 30]) {
    it(`keeps every entry of the explicit list at ${ms} ms a key`, async () => {
      const page = await mountPage(EXPLICIT);
      const box = () => input(page.container, 'Add tokens');
      await typeKeys(page, box, 'uh, eh, mm', ms);
      expect(box().value).toBe('uh, eh, mm');
      expect(page.server.ignoredTokens.blacklist).toEqual(['uh', 'eh', 'mm']);
      expect(page.refused).toEqual([]);
      await page.unmount();
    });
  }

  it('keeps every letter-like character typed fast', async () => {
    const page = await mountPage(PUNCT);
    const box = () => input(page.container, 'Separate with commas');
    await typeKeys(page, box, "ʼ, ', -, ~", 10);
    expect(box().value).toBe("ʼ, ', -, ~");
    expect(page.server.ignoredTokens.whitelist).toEqual(['ʼ', "'", '-', '~']);
    expect(page.refused).toEqual([]);
    await page.unmount();
  });
});

// The explicit list holds whole tokens and its placeholder offers ". , ; !",
// so a comma can be listed: one standing where an entry begins is the comma.
describe('a comma in the explicit list', () => {
  it('is an entry where one begins, and the list reads back as typed', async () => {
    const page = await mountPage(EXPLICIT);
    const box = () => input(page.container, 'Add tokens');
    await typeKeys(page, box, '., ,, ;', 0);
    expect(page.server.ignoredTokens.blacklist).toEqual(['.', ',', ';']);
    expect(box().value).toBe('., ,, ;');
    await page.unmount();
  });

  it('is listed from a list stored elsewhere, and a separator is not', async () => {
    const page = await mountPage({ ...EXPLICIT, explicitIgnoredTokens: [',', 'uh'] });
    const box = () => input(page.container, 'Add tokens');
    expect(box().value).toBe(',, uh');
    await typeKeys(page, box, ',, uh, eh', 0);
    expect(page.server.ignoredTokens.blacklist).toEqual([',', 'uh', 'eh']);
    await page.unmount();
  });
});
