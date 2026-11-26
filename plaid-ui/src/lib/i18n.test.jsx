import { describe, it, expect, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { t, tx, msg, language, startingLanguage, __test } from './i18n.js';

const switchLanguageForTest = __test.switchLanguage;

afterEach(async () => {
  localStorage.removeItem('plaid.language');
  await switchLanguageForTest('en');
});

const LEFT_OUT = '{n, plural, one {# sentence was} other {# sentences were}} left out of “{name}”.';

describe('t', () => {
  it('is the English with its values filled in when no catalog is loaded', () => {
    expect(t('Save')).toBe('Save');
    expect(t(LEFT_OUT, { n: 1, name: 'a:b.c' })).toBe('1 sentence was left out of “a:b.c”.');
    expect(t(LEFT_OUT, { n: 1200, name: 'x' })).toBe('1,200 sentences were left out of “x”.');
    expect(t("Don't save")).toBe("Don't save");
    expect(msg('Save')).toBe('Save');
  });

  it('is the translation in another language, with that language’s plurals', async () => {
    await switchLanguageForTest('fr', {
      Save: 'Enregistrer',
      [LEFT_OUT]:
        '{n, plural, one {# phrase a été omise} other {# phrases ont été omises}} de «\u00a0{name}\u00a0».',
    });
    expect(language()).toBe('fr');
    expect(t('Save')).toBe('Enregistrer');
    // French counts zero as one.
    expect(t(LEFT_OUT, { n: 0, name: 'x' })).toBe('0 phrase a été omise de «\u00a0x\u00a0».');
    expect(t(LEFT_OUT, { n: 2, name: 'x' })).toBe('2 phrases ont été omises de «\u00a0x\u00a0».');
    // No translation: the English.
    expect(t('Cancel')).toBe('Cancel');
  });
});

describe('tx', () => {
  it('renders the markup inside a sentence, wherever the translation puts it', async () => {
    const message = 'Delete <b>{name}</b> for good?';
    const values = { name: 'Story', b: (c) => <b>{c}</b> };
    expect(renderToStaticMarkup(<p>{tx(message, values)}</p>)).toBe(
      '<p>Delete <b>Story</b> for good?</p>',
    );
    await switchLanguageForTest('fr', {
      [message]: 'Supprimer définitivement <b>{name}</b>\u202f?',
    });
    expect(renderToStaticMarkup(<p>{tx(message, values)}</p>)).toBe(
      '<p>Supprimer définitivement <b>Story</b>\u202f?</p>',
    );
    expect(tx('Plain')).toBe('Plain');
  });
});

describe('startingLanguage', () => {
  it('is the picked language, else the browser’s first supported one, else English', () => {
    expect(startingLanguage()).toBe('en');
    localStorage.setItem('plaid.language', 'fr');
    expect(startingLanguage()).toBe('fr');
    localStorage.setItem('plaid.language', 'tlh');
    expect(startingLanguage()).toBe('en');
  });
});
