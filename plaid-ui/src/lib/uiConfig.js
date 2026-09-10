// The two things this package cannot know on its own, told to it once by the
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
  appPrefix: 'plaid_ui',
  // Optional. Given `(element) => cleanup`, the package's Input and Textarea
  // honor their `compose` prop by handing the element to it on mount. It is
  // how plaid-igt wires its backslash composer (`\sw` -> ə) into fields this
  // package owns without the composer itself — which reads a project's own
  // bound codes — having to live here. An app that registers nothing leaves
  // `compose` inert, which is the right behavior for an app with no codes.
  attachCompose: null,
};

let config = { ...DEFAULTS };

/** Tell the package about the app mounting it. Call once, at startup. */
export const configureUi = (next = {}) => {
  config = { ...DEFAULTS, ...next };
};

/** The app's localStorage prefix. */
export const appPrefix = () => config.appPrefix;

/** The app's compose attacher, or null. */
export const composeAttacher = () => config.attachCompose;
