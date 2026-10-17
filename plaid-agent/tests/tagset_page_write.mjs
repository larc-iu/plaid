// igt's own write of an approved tagset plan (plaid-igt domain/tagsetPlan.js
// `writeTagsetPlan`), run against a live core with the approver's token, the
// way the assistant adapter's `writeFirst` runs it: the plan's fields put in
// force inside the plan's operation, every other field after it. The tests of
// approval use it so they test the write users run (page_write.py).
//
// Reads {url, token, projectId, ops, operation} as JSON on stdin and writes
// {wrote, notInForce} or {error, status} to stdout.
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// plaid-igt's domain imports through the app's `@ui` alias, as vite maps it.
const UI = resolve(HERE, '../../plaid-ui/src');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@ui/')) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const DOMAIN = resolve(HERE, '../../plaid-igt/src/domain');
const { writeTagsetPlan } = await import(`${DOMAIN}/tagsetPlan.js`);
const { declareIgtRules } = await import(`${DOMAIN}/igtConstraints.js`);
const { PlaidClient } = await import(resolve(HERE, '../../plaid-client-js/src/index.js'));

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { url, token, projectId, ops, operation } = JSON.parse(input);
const client = new PlaidClient(url, token);

// putRulesInForce (plaid-igt settings/putRulesInForce.js) without its notice.
const inForce = async (layers) =>
  (await declareIgtRules(client, projectId, { fieldsOnly: true, repair: false, layers })).notInForce;

let out;
try {
  let own = null;
  let notInForce = [];
  const wrote = await writeTagsetPlan(client, projectId, { ops }, operation ?? null, {
    afterWrite: async (fieldIds) => {
      own = new Set(fieldIds);
      if (own.size) notInForce = await inForce(own.has.bind(own));
    },
  });
  if (wrote) notInForce = [...notInForce, ...(await inForce((id) => !own?.has(id)))];
  out = { wrote, notInForce };
} catch (error) {
  out = { error: error.message, status: error.cause?.status ?? error.status ?? null };
}
process.stdout.write(JSON.stringify(out));
