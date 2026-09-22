# plaid-ui

The screens and primitives `plaid-igt`, `plaid-ud`, `plaid-umr` and `plaid-dict`
share.

Not published. Each app aliases `@ui` to `plaid-ui/src` in its Vite and Vitest
config, the way they all alias `@larc-iu/plaid-client` to `plaid-client-js/src`,
and imports from it directly:

```js
import { Button } from '@ui/components/ui/button.jsx';
import { DataTable } from '@ui/components/shared/data-table.jsx';
import { usePagedList } from '@ui/hooks/usePagedList.js';
```

## Why it exists

Four apps, one substrate. A screen that is the same in two of them: the data
table, the list chrome, a confirm dialog, later the service-run dialog, the
comments browser, the activity panel, the assistant tab, was going to be
written twice and fixed once. The run lifecycle alone took two bug hunts to get
right in plaid-igt; a second copy of it would have inherited none of that.

## What goes in

A module belongs here when it is **app-agnostic**: it takes its domain as props
or an adapter, and nothing in it names a project shape, a layer role, or a
config namespace. A screen that differs in domain (what an anchor is, what a run
writes) still belongs here, with the domain passed in.

A module does NOT belong here just because two apps happen to want it today. If
making it shared means giving it a flag for "the IGT case", it is two screens.

## What it does not know

Facts the package cannot work out for itself, told to it once from the app's
entry point via `configureUi` (see `src/lib/uiConfig.js`). The first three are
REQUIRED and throw when read without one, so a forgotten `configureUi` or a
second instance of the module is loud rather than silently wrong:

- **`appPrefix`**: every localStorage key this package writes is prefixed with
  it, so a sort order remembered for one app's document list does not decide how
  another's opens. plaid-igt passes `plaid_igt`, which is the prefix its keys
  have always carried.
- **`configNamespace`**: `igt` / `ud` / `dict`, the app's half of a project's
  `config` bucket, for reading the service defaults a maintainer set per spot.
- **`appName`**: what the app is called on screen, `Plaid IGT` / `Plaid UD`.
  `useDocumentTitle` ends every tab title with it.
- **`attachCompose`**: optional. `Input` and `Textarea` take a `compose` prop
  that turns on a character composer; the composer itself reads a project's own
  bound codes, so it lives in the app. An app that registers nothing leaves the
  prop inert.

## Dependencies

Peer dependencies only: the package is compiled by whichever app imports it, and
that app's copy of React, Radix, lucide and the rest is the one that runs. The
list in `package.json` is what a consuming app has to have. An app that never
imports `lib/markdown.js` does not need `marked` or `dompurify`.

## Two component directories

`components/ui/` holds the vendored shadcn primitives and nothing else, so a
file there can be refreshed from upstream. Four of them carry a "modified from
shadcn" banner at the top and must be re-patched after a refresh: `tabs.jsx`,
`input.jsx`, `textarea.jsx` and `select.jsx`. Everything this package wrote
itself, including the table, the list chrome, the combobox and the markdown
renderer, lives in `components/shared/`.

## Tailwind

`tailwind.preset.js` carries the theme every app that mounts this package
shares: dark mode, the shadcn token names, the radii and the accordion
keyframes. An app spreads it as a preset AND lists the package's own sources in
its `content`:

```js
import plaidUi, { PLAID_UI_CONTENT } from '../plaid-ui/tailwind.preset.js';
export default {
  presets: [plaidUi],
  content: ['./index.html', './src/**/*.{js,jsx}', PLAID_UI_CONTENT],
  plugins: [animate, typography],
};
```

Both halves are required. `theme.extend` merges across presets; `content` does
NOT, so a glob left in the preset is dropped silently by any app naming its own
and every class this package uses goes missing from the stylesheet. That cost
each app 20 to 36 KB of CSS before it was caught, and `tailwindPreset.test.js`
checks the resolved config now.

The shared tokens in `src/index.css` are the provenance palette, and only that:
the shadcn tokens themselves stay per app, since a dictionary reader and an
annotation editor are allowed to look different, while the same violet must mean
"a machine proposed this" everywhere.

## Tests

The package's tests run under **plaid-igt's** vitest, which includes this
directory: the tests need a React and a happy-dom, and running them under every
app would run them four times to learn the same thing.

`components/shared/data-table.usage.test.js` is the exception that reads outward:
it scans every app's `src/` for `<DataTable>` call sites, because a call site in
any of them can break the table's invariants.
