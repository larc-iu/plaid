# plaid-ui

The screens and primitives `plaid-igt`, `plaid-ud` and `plaid-dict` share.

Not published. Each app aliases `@ui` to `plaid-ui/src` in its Vite and Vitest
config, the way they all alias `@larc-iu/plaid-client` to `plaid-client-js/src`,
and imports from it directly:

```js
import { Button } from '@ui/components/ui/button.jsx';
import { DataTable } from '@ui/components/ui/data-table.jsx';
import { usePagedList } from '@ui/hooks/usePagedList.js';
```

## Why it exists

Three apps, one substrate. A screen that is the same in two of them — the data
table, the list chrome, a confirm dialog, later the service-run dialog, the
comments browser, the activity panel, the assistant tab — was going to be
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

Two facts the package cannot work out for itself, told to it once from the app's
entry point via `configureUi` (see `src/lib/uiConfig.js`):

- **`appPrefix`** — every localStorage key this package writes is prefixed with
  it, so a sort order remembered for one app's document list does not decide how
  another's opens. plaid-igt passes `plaid_igt`, which is the prefix its keys
  have always carried.
- **`attachCompose`** — optional. `Input` and `Textarea` take a `compose` prop
  that turns on a character composer; the composer itself reads a project's own
  bound codes, so it lives in the app. An app that registers nothing leaves the
  prop inert.

## Dependencies

Peer dependencies only: the package is compiled by whichever app imports it, and
that app's copy of React, Radix, lucide and the rest is the one that runs. The
list in `package.json` is what a consuming app has to have. An app that never
imports `lib/markdown.js` does not need `marked` or `dompurify`.

## Tailwind

Each app's `tailwind.config.js` includes `../plaid-ui/src/**/*.{js,jsx}` in its
`content` globs, or the classes in here are never emitted. The shared tokens in
`src/index.css` are the provenance palette, and only that: the shadcn tokens
themselves stay per app, since a dictionary reader and an annotation editor are
allowed to look different, while the same violet must mean "a machine proposed
this" everywhere.

## Tests

The package's tests run under **plaid-igt's** vitest, which includes this
directory: the tests need a React and a happy-dom, and running them under all
three apps would run them three times to learn the same thing.

`components/ui/data-table.usage.test.js` is the exception that reads outward —
it scans every app's `src/` for `<DataTable>` call sites, because a call site in
any of them can break the table's invariants.
