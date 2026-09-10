import { lazy } from 'react';

// React.lazy for a module's NAMED export, so a screen that is rarely visited
// (an import wizard, the admin area, the export tab) is downloaded when it is
// first opened rather than with the first page. `loader` is the dynamic
// import; `name` is the export.
export const lazyNamed = (loader, name) => lazy(() => loader().then((m) => ({ default: m[name] })));
