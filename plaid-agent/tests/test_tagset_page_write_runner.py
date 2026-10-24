"""The runner of igt's own tagset write (``tagset_page_write.mjs``) answers as
the page's ``writeFirst`` does. A failed declaration of the rules after the
settings landed is the page's ``putRulesInForce`` failing: it says so and
answers null, the write still counts as written, and the page approves with
wroteFirst. The runner reported it as a failed write (REV-R2-PY-3). Here igt's
two domain modules are stubbed through a module hook, so no core is needed."""

import json
import subprocess

from node_exe import node_or_skip
from page_write import RUNNER

STUBS = r"""
import { registerHooks } from 'node:module';
const PLAN = `export const writeTagsetPlan = async (client, projectId, plan, operation, { afterWrite }) => {
  await afterWrite(['f1']);
  return true;
};`;
const RULES = `let calls = 0;
export const declareIgtRules = async () => {
  calls += 1;
  if (calls === 2) throw new Error('core went away');
  return { notInForce: ['f1'] };
};`;
const as = (src) => ({ url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/plaid-igt/src/domain/tagsetPlan.js')) return as(PLAN);
    if (specifier.endsWith('/plaid-igt/src/domain/igtConstraints.js')) return as(RULES);
    return next(specifier, context);
  },
});
"""


def test_a_rules_declaration_that_fails_after_the_write_still_reports_it_written(tmp_path):
    node = node_or_skip("The runner is a node script.")
    hooks = tmp_path / 'stubs.mjs'
    hooks.write_text(STUBS)
    body = {'url': 'http://core.invalid', 'token': 't', 'projectId': 'p1', 'ops': [], 'operation': None}
    run = subprocess.run([node, '--import', hooks.as_uri(), RUNNER], input=json.dumps(body),
                         capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout) == {'wrote': True, 'notInForce': ['f1']}
