import { describe, it, expect, afterEach } from 'vitest';

import { configureUi, appName, appPrefix, configNamespace } from './uiConfig.js';

// The setup file configures the package for the whole run, so anything that
// clears it puts it back.
const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };
afterEach(() => configureUi(RESTORE));

describe('the facts an app tells the package', () => {
  it('hands back what the app named', () => {
    configureUi({ appPrefix: 'p', configNamespace: 'ud', appName: 'Plaid UD' });
    expect(appName()).toBe('Plaid UD');
    expect(appPrefix()).toBe('p');
    expect(configNamespace()).toBe('ud');
  });

  it('throws on a read the app never answered, rather than guessing', () => {
    // A forgotten configureUi, or a second instance of this module, has to be
    // loud: a wrong app name and a rekeyed list are both silent.
    configureUi({});
    expect(() => appName()).toThrow(/appName/);
    expect(() => appPrefix()).toThrow(/appPrefix/);
    expect(() => configNamespace()).toThrow(/configNamespace/);
  });
});
