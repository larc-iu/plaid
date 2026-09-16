// The two path aliases Vite gives the app, for the live scripts that run this
// code through plain node instead.
//
// `@/` is plaid-igt's own src and `@ui/` is the shared plaid-ui package. Vite
// resolves both (see vite.config.js); node resolves neither, so a live script
// that reaches any module using one dies at import with
// `ERR_MODULE_NOT_FOUND: Cannot find package '@ui/domain'`. That is what
// happened to every script here the day `IgtDocument` started extending
// `DocumentModel`, which lives in the package.
//
// Used as `node --import ./e2e/live/aliases.mjs <script>`. It cannot be a plain
// import inside a script: every import in a module graph is RESOLVED before any
// module body runs, so a registration in the body comes too late for the
// aliases in the same file.
import { register } from 'node:module';

register(new URL('./aliasHooks.mjs', import.meta.url));
