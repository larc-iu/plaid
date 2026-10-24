"""The Assistant panel, headless: what plaid-ui's AssistantChat and jobs.js do
for a turn and for an approval, done with the Python client as the user.

The assistant service is the only writer of a conversation record, and this
is a request-only client of it, as the page is:

A turn asks the service `{op: 'send', text, where, create}` (create on the
first), with a request id minted here and no open operation. The service
appends the message, answers it, and writes the record before it answers.
An approval asks `{op: 'approve', plan_id, as_human}`. A plan the app writes
itself (every op of a kind the registry stages `APP`, igt's tagset changes)
goes as jobs.js sends it: a preflight (`preflight: true`), on `ready` igt's
own `writeTagsetPlan` under node with the user's token
(plaid-agent/tests/tagset_page_write.mjs, from the code snapshot), then the
approval with `wrote_first`, or `unmark` when the write failed. All name
one fixed tab, which holds the conversation. The record is only read here.

The message's `where` carries the document's name, as the panel's does, and
the first turn sets the entry's `about`.
"""
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, Dict, Optional


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def wait_for_service(client, project_id: str, app: str, timeout=300) -> Dict[str, Any]:
    """The assistant for `app` once it is registered on the project."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for s in client.messages.discover_services(project_id) or []:
            sid = s.get('service_id') or s.get('id') or ''
            extras = s.get('extras') or {}
            if sid.startswith(f'{app}:assist:') and (extras.get('app') in (None, app)) \
                    and s.get('online', True) is not False:
                s['service_id'] = sid
                return s
        time.sleep(1)
    raise TimeoutError(f'no {app} assistant on project {project_id} after {timeout}s')


class Panel:
    def __init__(self, client, user_id: str, project_id: str, app: str, service: Dict[str, Any],
                 timeout_s: float = 1800, code: Optional[Path] = None):
        self.client = client
        # The code snapshot (code/<sha>), whose igt write a plan the app
        # writes itself is written with.
        self.code = Path(code) if code else None
        self.user_id = user_id
        self.project_id = project_id
        self.app = app
        self.service = service
        self.timeout_s = timeout_s
        self.conv_id = str(uuid.uuid4())
        # The one tab this panel is: it holds the conversation it starts.
        self.tab = f'bench-{uuid.uuid4()}'
        self.created = False
        self.progress = []

    @property
    def service_id(self):
        return self.service['service_id']

    def _on_progress(self, p):
        self.progress.append({'t': time.time(), 'p': p if isinstance(p, (dict, str, int, float)) else str(p)})

    def _read(self, kind: str):
        key = f'{self.app}:assistant:{self.project_id}:{kind}:{self.conv_id}'
        try:
            return (self.client.user_data.get(self.user_id, key) or {}).get('value')
        except Exception:  # noqa: BLE001 - a conversation not written yet
            return None

    def load(self):
        """The record as the service wrote it: (transcript, sidebar entry)."""
        conv = self._read('conv')
        if not isinstance(conv, dict):
            return {'messages': [], 'display': []}, None
        return {'messages': conv.get('messages') or [], 'display': conv.get('display') or []}, self._read('meta')

    def turn(self, text: str, where: Optional[Dict[str, Any]] = None, projects=None) -> Dict[str, Any]:
        data = {'project_id': self.project_id, 'conversation_id': self.conv_id, 'tab': self.tab,
                'op': 'send', 'text': text, 'create': not self.created}
        if where:
            data['where'] = {'kind': where['kind'], 'id': where['id'], 'name': where.get('name')}
        out = self._ask(data, str(uuid.uuid4()), projects=projects)
        self.created = True
        return out

    def approve(self, plan_id: str, as_human: bool = False) -> Dict[str, Any]:
        conv, _ = self.load()
        item = next((d for d in conv['display'] if (d.get('plan') or {}).get('id') == plan_id), None)
        plan = (item or {}).get('plan') or {}
        base = {'project_id': self.project_id, 'conversation_id': self.conv_id, 'tab': self.tab}
        approve = {**base, 'op': 'approve', 'plan_id': plan_id, 'as_human': as_human}
        if not self._writes_first(plan.get('ops') or []):
            return self._ask(approve, str(uuid.uuid4()))
        ready = self._ask({**approve, 'preflight': True}, str(uuid.uuid4()))
        if ready['error'] or (ready['result'] or {}).get('kind') != 'ready':
            return ready
        try:
            wrote = self._page_write(plan)
        except Exception as e:  # noqa: BLE001 - the page takes its mark off and shows it
            self._ask({**base, 'op': 'unmark', 'plan_id': plan_id}, str(uuid.uuid4()))
            return {'request_id': None, 'error': f'app write: {type(e).__name__}: {e}'[:2000],
                    'result': None, 'started': time.time(), 'first_progress_s': None, 'wall_s': 0}
        # As the page: wroteFirst only when igt's write wrote (writeTagsetPlan
        # answers false when every setting already reads as planned).
        return self._ask({**approve, 'wrote_first': True} if wrote else approve, str(uuid.uuid4()))

    def _writes_first(self, ops) -> bool:
        """Whether the app writes this plan before the approval, as igt's
        adapter decides it (`isTagsetPlan`): every op of a kind the
        registry stages APP. Only igt has such kinds."""
        if self.app != 'igt' or not ops:
            return False
        from plaid_agent.igt.plan import APP, KIND
        return all(getattr(KIND.get(op.get('kind')), 'stage', None) == APP for op in ops)

    def _page_write(self, plan) -> bool:
        """igt's own write of the plan with the user's token, under the
        plan's operation as plaid-ui `planOperation` names it. Answers
        whether it wrote anything. Raises when the write refused or failed."""
        from plaid_client.transforms import transform_request
        if self.code is None:
            raise RuntimeError('no code snapshot to run the app write from')
        runner = self.code / 'plaid-agent' / 'tests' / 'tagset_page_write.mjs'
        node = os.environ.get('PLAID_NODE') or shutil.which('node')
        if not runner.is_file() or not node:
            raise RuntimeError(f'cannot run the app write ({runner} under {node}); rebuild the snapshot '
                               'with code.sh, which takes plaid-igt, plaid-ui and plaid-client-js too')
        label = f'Assistant: {plan.get("summary") or ""}'.translate({c: None for c in range(0x2066, 0x206A)})
        operation = {'message': label if len(label) <= 400 else label[:399] + '…',
                     'kind': 'assistant-plan',
                     'ref': f'conv:{self.conv_id}/plan:{plan.get("id")}/service:{self.service_id}'}
        body = {'url': self.client.base_url, 'token': self.client.token, 'projectId': self.project_id,
                'ops': transform_request(plan.get('ops') or []), 'operation': operation}
        run = subprocess.run([node, str(runner)], input=json.dumps(body), capture_output=True, text=True,
                             timeout=300)
        if run.returncode:
            raise RuntimeError(run.stderr.strip()[-1000:])
        out = json.loads(run.stdout)
        if 'error' in out:
            raise RuntimeError(out['error'])
        return bool(out.get('wrote'))

    def _ask(self, data, rid, projects=None) -> Dict[str, Any]:
        t0 = time.time()
        out = {'request_id': rid, 'error': None, 'result': None, 'started': t0, 'first_progress_s': None}
        seen = len(self.progress)
        try:
            out['result'] = self.client.messages.request_service(
                self.project_id, self.service_id, data, self.timeout_s, self._on_progress,
                request_id=rid, project_ids=projects or [], no_operation=True)
        except Exception as e:  # noqa: BLE001 - recorded, the record says the rest
            out['error'] = f'{type(e).__name__}: {e}'[:2000]
        out['wall_s'] = round(time.time() - t0, 2)
        # How long the service took to answer at all (an approval's first
        # progress, a send's `recorded`), the wall time of its model-free part.
        if len(self.progress) > seen:
            out['first_progress_s'] = round(self.progress[seen]['t'] - t0, 3)
        return out

    def open_plan(self) -> Optional[Dict[str, Any]]:
        """The newest plan in the record that is still undecided, from any turn."""
        conv, _ = self.load()
        for d in reversed(conv['display']):
            if d.get('kind') == 'assistant' and d.get('plan'):
                return d if d.get('status') is None else None
        return None

    def last_plan(self) -> Optional[Dict[str, Any]]:
        """The newest undecided plan in the record, as its display item."""
        conv, _ = self.load()
        for d in reversed(conv['display']):
            if d.get('kind') == 'assistant' and d.get('plan'):
                return d
            if d.get('kind') == 'user':
                return None
        return None
