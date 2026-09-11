// What main.jsx does before it renders, for tests that mount a component from
// plaid-ui. The package refuses to build a storage key for an app that named no
// prefix, so a list mounted without this fails loudly rather than remembering
// its sort somewhere nobody chose.
import { configureUi } from '@ui/lib/uiConfig.js';

configureUi({ appPrefix: 'plaid_dict', configNamespace: 'dict' });
