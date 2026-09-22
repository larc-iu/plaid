// What main.jsx does before it renders, for tests that mount a component from
// plaid-ui. The package refuses to build a storage key for an app that named no
// prefix, so a list mounted without this fails loudly rather than remembering
// its sort somewhere nobody chose.
import { configureUi } from '@ui/lib/uiConfig.js';
import { APP_ROUTES } from '../appRoutes.js';

// The shared package's own tests run here as well as this app's, and a shared
// screen reads the mounting app's routes the moment it has a link to draw. So
// this says what main.jsx says: without it every such screen throws on mount
// instead of testing anything.
configureUi({
  appPrefix: 'plaid_igt',
  configNamespace: 'igt',
  appName: 'Plaid IGT',
  appRoutes: APP_ROUTES,
});

// Nothing scrolls in a test environment, and jsdom does not define
// scrollIntoView at all, so a component that scrolls something into view after
// a render (the assistant's transcript, a list reaching a row) throws on mount
// under a `// @vitest-environment jsdom` pragma. happy-dom defines it as a
// no-op, which is why this is here rather than in any one test file: what
// needs it is whichever environment a test asks for.
Element.prototype.scrollIntoView ??= () => {};
