"""Live check that a request deadline is IDLE time, not a cap on the run.

Stands up a throwaway ``BaseService`` that talks steadily for longer than the
deadline, and a second that goes quiet for longer than the deadline, and asks
for both under the same short deadline.

    python services/probes/idle_deadline_probe.py --url http://localhost:8085

A service that is reporting its progress is not hung, so every event it sends
starts the clock again. As a deadline on the whole run, the five-minute default
was shorter than a real transcription: a working run was reported as failed and
its writes landed on a document the page had already handed back as editable.

The second half checks the other side of that contract: when the client really
does give up, the error says the request is STILL THERE (``pending``), because
the service goes on working and its result can be rejoined by id. Callers use
that to decide whether to forget the run or keep it for the next reload.

``--serve-only <id>`` registers and stays up instead of testing, so
``e2e/idle-deadline-live.mjs`` can put the JS client through the same two runs.
"""
import argparse
import os
import time

from plaid_client import PlaidClient
from plaid_client.service import BaseService

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://localhost:8085')
parser.add_argument('--token', default=None)
parser.add_argument('--serve-only', metavar='SERVICE_ID',
                    help='register under this id and stay up, for the JS half '
                         '(e2e/idle-deadline-live.mjs) to request against')
args = parser.parse_args()

token = args.token or open(os.path.join(os.path.dirname(__file__), '..', '.token')).read().strip()
client = PlaidClient(args.url, token)
project = next(p for p in client.projects.list() if p['name'] == 'E2E IGT Fixture')
project_id = project['id']
service_id = args.serve_only or f'probe:idle-{int(time.time())}'

TALK_STEPS = 10      # one a second, so a 10s run
QUIET_S = 8.0        # one silence, longer than the deadline
DEADLINE_S = 3.0


class IdleProbe(BaseService):
    def process_request(self, request_data, response_helper):
        if request_data.get('quiet'):
            response_helper.progress(1, 'about to go quiet')
            time.sleep(QUIET_S)
            response_helper.complete({'finished': True})
            return
        for i in range(TALK_STEPS):
            response_helper.progress(int(100 * i / TALK_STEPS), f'step {i}')
            time.sleep(1.0)
        response_helper.complete({'finished': True})


probe = IdleProbe(service_id, 'Idle deadline probe', 'throwaway')
probe.client = client
registration = client.messages.serve(
    project_id,
    {'service_id': service_id, 'service_name': 'Idle deadline probe'},
    probe.handle_service_request,
    {'schema_version': 1, 'tasks': [], 'summary': 'throwaway'},
)
time.sleep(1.5)

if args.serve_only:
    print(f'serving {service_id} on project {project_id}; Ctrl-C to stop', flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        registration.stop()
    raise SystemExit(0)

failures = []

# 1. Talks for 10s under a 3s deadline. It never goes quiet, so it must finish.
started = time.monotonic()
try:
    result = client.messages.request_service(
        project_id, service_id, {'quiet': False}, timeout=DEADLINE_S,
        on_progress=lambda p: print(f"  @{time.monotonic() - started:4.1f}s {p.get('message')}"))
    took = time.monotonic() - started
    print(f'talkative: finished in {took:.1f}s under a {DEADLINE_S}s deadline -> {result}')
    if took <= DEADLINE_S:
        failures.append('the talkative run was shorter than the deadline; nothing was proved')
except Exception as e:
    failures.append(f'the talkative run was killed at {time.monotonic() - started:.1f}s: {e}')

# 2. One silence longer than the deadline. It must give up, and say the request
#    is still out there rather than reporting the run as over.
started = time.monotonic()
try:
    client.messages.request_service(project_id, service_id, {'quiet': True}, timeout=DEADLINE_S)
    failures.append('the quiet run was not given up on')
except TimeoutError as e:
    took = time.monotonic() - started
    print(f'quiet: gave up after {took:.1f}s -> {e}')
    if getattr(e, 'pending', False) is not True:
        failures.append('the timeout did not say the request is still there (pending)')
    if 'of silence' not in str(e):
        failures.append(f'the timeout did not name silence as the reason: {e}')
except Exception as e:
    failures.append(f'the quiet run raised {type(e).__name__} instead of TimeoutError: {e}')

registration.stop()
for f in failures:
    print('FAIL:', f)
print('PASS: a talking run outlives the deadline, a silent one does not, and giving up keeps the id'
      if not failures else 'FAILED')
raise SystemExit(1 if failures else 0)
