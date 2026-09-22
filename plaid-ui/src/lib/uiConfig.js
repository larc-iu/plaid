// The things this package cannot know on its own, told to it once by the app
// that mounts it. Call `configureUi` from the app's entry point, before
// anything renders.
//
// Module-level state rather than a context, deliberately: they are read from
// places that are not components (a localStorage key builder, a native DOM
// listener), there is exactly one app per bundle, and none of them ever
// changes while an app runs. A provider would put a React boundary around
// facts that have nothing to do with the tree.

const DEFAULTS = {
  // Prefixes every localStorage key this package writes. Two apps on one
  // machine share an origin only in the packaged build, but they would share
  // key names everywhere: a sort order remembered for IGT's document list must
  // not decide how UD's opens.
  //
  // There is deliberately NO default. An app that forgets `configureUi`, or one
  // whose bundler has quietly given this module a second instance, would
  // otherwise write every key under a prefix nobody chose, which is invisible
  // until someone notices their remembered sorts are gone. `listPrefKey` throws
  // instead. That is not hypothetical: it shipped once, when an alias through
  // node_modules made the optimizer pre-bundle this file (../vite.js).
  appPrefix: null,
  // Optional. Given `(element) => cleanup`, the package's Input and Textarea
  // honor their `compose` prop by handing the element to it on mount. It is
  // how plaid-igt wires its backslash composer (`\sw` -> ə) into fields this
  // package owns without the composer itself, which reads a project's own
  // bound codes: having to live here. An app that registers nothing leaves
  // `compose` inert, which is the right behavior for an app with no codes.
  attachCompose: null,
  // The app's own namespace inside a project's or a layer's `config` bucket:
  // 'igt', 'ud', 'dict'. Shared code that reads a project's configuration (the
  // service defaults a maintainer set for each spot) needs to know which half
  // of the bucket is this app's. No default, for the same reason `appPrefix`
  // has none: reading the wrong app's settings is silent and wrong.
  configNamespace: null,
  // What the app is called on screen: 'Plaid IGT', 'Plaid UD'. The tab title
  // ends with it. No default, for the same reason the two above have none: a
  // wrong app name is silent, and a second module instance is exactly what
  // this catches.
  appName: null,
  // Where this app keeps the screens shared code has to link to. A screen that
  // lives here (the Activity panel's rows, the Comments tab's jump links, the
  // bounce out of a project a reader may not manage) has to address a place in
  // the app that mounted it, and the apps do not agree: plaid-igt opens a
  // document at /projects/:p/documents/:d and plaid-ud at the same path plus
  // /annotate. `packageBoundaries.test.js` is what keeps them from being
  // guessed at here.
  //
  //   { projects, documents(projectId), document(projectId, documentId),
  //     sentence(projectId, documentId, sentenceId) }
  //
  // No default: a shared screen reads it only when it has a link to draw, and
  // an app that mounts such a screen without naming its routes is told so
  // rather than linking somewhere plausible and wrong.
  appRoutes: null,
};

let config = { ...DEFAULTS };

/** Tell the package about the app mounting it. Call once, at startup. */
export const configureUi = (next = {}) => {
  config = { ...DEFAULTS, ...next };
};

/** The app's localStorage prefix. Throws if the app never named one. */
export const appPrefix = () => {
  if (!config.appPrefix) {
    throw new Error(
      'plaid-ui: no appPrefix. Call configureUi({appPrefix}) from the app entry, ' +
        'and check that this module has not been loaded twice.',
    );
  }
  return config.appPrefix;
};

/** The app's compose attacher, or null. */
export const composeAttacher = () => config.attachCompose;

/** What the app is called on screen. Throws if the app never named itself. */
export const appName = () => {
  if (!config.appName) {
    throw new Error('plaid-ui: no appName. Call configureUi({appName}) from the app entry.');
  }
  return config.appName;
};

/** Where the app keeps the screens shared code links to. Throws if unnamed. */
export const appRoutes = () => {
  if (!config.appRoutes) {
    throw new Error(
      'plaid-ui: no appRoutes. Call configureUi({appRoutes}) from the app entry ' +
        'before mounting a shared screen that links into the app.',
    );
  }
  return config.appRoutes;
};

/** The app's namespace in a config bucket. Throws if the app never named one. */
export const configNamespace = () => {
  if (!config.configNamespace) {
    throw new Error(
      'plaid-ui: no configNamespace. Call configureUi({configNamespace}) from the app entry.',
    );
  }
  return config.configNamespace;
};
