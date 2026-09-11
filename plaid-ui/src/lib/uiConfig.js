// The three things this package cannot know on its own, told to it once by the
// app that mounts it. Call `configureUi` from the app's entry point, before
// anything renders.
//
// Module-level state rather than a context, deliberately: both values are read
// from places that are not components (a localStorage key builder, a native
// DOM listener), there is exactly one app per bundle, and neither ever changes
// while an app runs. A provider would put a React boundary around facts that
// have nothing to do with the tree.

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

/** The app's namespace in a config bucket. Throws if the app never named one. */
export const configNamespace = () => {
  if (!config.configNamespace) {
    throw new Error(
      'plaid-ui: no configNamespace. Call configureUi({configNamespace}) from the app entry.',
    );
  }
  return config.configNamespace;
};
