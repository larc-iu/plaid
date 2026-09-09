"""Live check of cooperative cancellation in the Python service framework.

Stands up a throwaway ``BaseService`` — the same path all five bundled services
take — that reports progress in a loop, asks it to stop mid-run, and asserts
the request comes back STOPPED rather than failed, and that a ``critical``
stretch still finishes.

    python services/cancel_probe.py --url http://localhost:8085

This exercises two things that have to hold together: the handler runs off the
SSE reader thread (or the channel could not deliver the stop for the request it
is running), and ``progress()`` is the checkpoint that sees it.
"""
import argparse
import os
import threading
import time

from plaid_client import PlaidClient, ServiceCancelled
from plaid_client.service import BaseService

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://localhost:8085')
parser.add_argument('--token', default=None)
args = parser.parse_args()

token = args.token or open(os.path.join(os.path.dirname(__file__), '..', '.token')).read().strip()
client = PlaidClient(args.url, token)
project = next(p for p in client.projects.list() if p['name'] == 'E2E IGT Fixture')
project_id = project['id']
service_id = f'probe:cancel-py-{int(time.time())}'

log = []


class CancelProbe(BaseService):
    def process_request(self, request_data, response_helper):
        try:
            # A loop that reports progress is already a cancellation checkpoint.
            for i in range(200):
                response_helper.progress(i, f'step {i}')
                time.sleep(0.1)
            response_helper.complete({'finished': True})
        except ServiceCancelled:
            log.append('raised at the checkpoint')
            # The writes must still go through once begun.
            with response_helper.critical():
                response_helper.progress(99, 'committing')
                log.append('critical block ran to completion')
            raise  # let serve() report it as stopped


probe = CancelProbe(service_id, 'Cancel probe (py)', 'throwaway')
probe.client = client
registration = client.messages.serve(
    project_id,
    {'service_id': service_id, 'service_name': 'Cancel probe (py)'},
    probe.handle_service_request,
    {'schema_version': 1, 'tasks': [], 'summary': 'throwaway'},
)
time.sleep(1.5)

accepted = {}


def stop_it_soon(request_id):
    accepted['id'] = request_id

    def ask():
        try:
            client.messages.cancel_service_request(project_id, request_id)
            print('cancel: accepted by the server')
        except Exception as e:  # a Timer thread swallows this otherwise
            print('cancel FAILED:', type(e).__name__, e)

    threading.Timer(1.2, ask).start()


result = client.messages.request_service(
    project_id, service_id, {}, timeout=60, on_accepted=stop_it_soon)
registration.stop()

print('request', accepted.get('id'))
print('handler log:', log)
print('result:', result)
ok = result.get('stopped') is True and 'critical block ran to completion' in log
print('PASS: stopped cleanly, critical section finished' if ok else 'FAIL')
raise SystemExit(0 if ok else 1)
