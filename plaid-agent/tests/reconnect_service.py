"""A service process for test_service_reconnect_live.py.

  reconnect_service.py URL SERVICE_ID LOG PROJECT...

Serves SERVICE_ID (model pool "reconnect-test") on each PROJECT with the token
in PLAID_TEST_TOKEN. Each request reports progress every 0.3 s for
RECONNECT_TEST_WORK_S seconds (default 6), then completes. On SIGUSR1 every
stream is cut, and reopened no sooner than RECONNECT_TEST_AWAY_S seconds later
(default 0). Each event is a JSON line in LOG: serving, status, got, gone,
cancelled, completed.
"""
import json
import os
import signal
import sys
import threading
import time

from plaid_client import PlaidClient
import plaid_client.services as svc
from plaid_client.sse import abort_response

url, service_id, log, projects = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
work_s = float(os.environ.get('RECONNECT_TEST_WORK_S', '6'))
away_s = float(os.environ.get('RECONNECT_TEST_AWAY_S', '0'))
lock = threading.Lock()


def say(event, **fields):
    with lock, open(log, 'a') as f:
        f.write(json.dumps({'event': event, 'pid': os.getpid(), 't': time.time(), **fields}) + '\n')


client = PlaidClient(url, os.environ['PLAID_TEST_TOKEN'])


def handler(data, helper):
    rid = helper.request_id
    say('got', request=rid)
    try:
        end = time.monotonic() + work_s
        while time.monotonic() < end:
            helper.progress(50, 'working')
            time.sleep(0.3)
        helper.complete({'done': True, 'pid': os.getpid()})
        say('completed', request=rid)
    except svc.ServiceRequestGone:
        say('gone', request=rid)
    except svc.ServiceCancelled:
        say('cancelled', request=rid)
        helper.stopped()


regs = []
for pid in projects:
    regs.append(svc.serve(client, pid, {'service_id': service_id, 'service_name': 'Reconnect test'},
                          lambda d, h: threading.Thread(target=handler, args=(d, h), daemon=True).start(),
                          extras={'model_pool': 'reconnect-test'},
                          on_status=lambda ev, p, d: say('status', status=ev, project=p, detail=str(d))))
until = {'t': 0.0}


def held_open(reg):
    real = reg._open_channel

    def open_channel():
        while time.monotonic() < until['t']:
            time.sleep(0.1)
        return real()
    return open_channel


for reg in regs:
    reg._open_channel = held_open(reg)


def cut(*_):
    until['t'] = time.monotonic() + away_s
    for reg in regs:
        conn = reg._connection
        if conn is not None:
            abort_response(getattr(conn, '_response', None))
    say('cut')


signal.signal(signal.SIGUSR1, cut)
say('serving', instance=svc.INSTANCE_ID)
while True:
    time.sleep(1)
