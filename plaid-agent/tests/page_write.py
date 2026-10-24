"""The page's write of an approved tagset plan, for the tests of approval.

A delegated token may not write settings, so the app writes a plan of tagset
changes with the approver's session before the approval goes. These tests run
igt's own write (``tagset_page_write.mjs``) under node against the live core,
as the client they are given."""

import json
import os
import subprocess
from typing import Optional

from node_exe import node_or_skip
from plaid_client.transforms import transform_request

RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tagset_page_write.mjs')


class PageRefused(Exception):
    """The page's write refused the plan, writing nothing. ``status`` is
    core's, when core refused it."""

    def __init__(self, message: str, status: Optional[int]):
        super().__init__(message)
        self.status = status


def page_write(client, project_id: str, ops, operation: Optional[dict] = None) -> list:
    """Write ``ops`` (the plan's) as igt's ``writeTagsetPlan`` does, under
    ``operation`` ({message, kind, ref}) when given. Returns the fields left
    out of force. Raises :class:`PageRefused` when the page refuses."""
    node = node_or_skip("The tagset approval tests run igt's own write with it.")
    body = {'url': client.base_url, 'token': client.token, 'projectId': project_id,
            # As the record carries them over the wire: kebab-cased, then
            # camelCased by the JS client (tagset_page_write.mjs).
            'ops': transform_request(ops), 'operation': operation}
    run = subprocess.run([node, RUNNER], input=json.dumps(body), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr
    out = json.loads(run.stdout)
    if 'error' in out:
        raise PageRefused(out['error'], out['status'])
    return out['notInForce']
