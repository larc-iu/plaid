import json
import logging
import threading
import time

import requests

from plaid_client.transforms import transform_response

logger = logging.getLogger(__name__)


class SSEConnection:
    def __init__(self, client, project_id, on_event):
        self._start_time = time.time()
        self._is_connected = False
        self._is_closed = False
        self._client_id = None
        self._event_stats = {'audit-log': 0, 'message': 0, 'heartbeat': 0, 'connected': 0, 'other': 0}
        self._stop_event = threading.Event()
        self._response = None
        self._ready_state = 0  # CONNECTING

        self._client = client
        self._project_id = project_id
        self._on_event = on_event

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    @property
    def ready_state(self):
        return self._ready_state

    def close(self):
        if not self._is_closed:
            self._is_closed = True
            self._is_connected = False
            self._ready_state = 2  # CLOSED
            self._stop_event.set()
            if self._response:
                self._response.close()

    def get_stats(self):
        return {
            'duration_seconds': time.time() - self._start_time,
            'is_connected': self._is_connected,
            'is_closed': self._is_closed,
            'client_id': self._client_id,
            'events': dict(self._event_stats),
            'ready_state': self._ready_state,
        }

    def _send_heartbeat(self):
        if not self._client_id or self._is_closed:
            return
        try:
            requests.post(
                f'{self._client.base_url}/api/v1/projects/{self._project_id}/heartbeat',
                headers={
                    'Authorization': f'Bearer {self._client.token}',
                    'Content-Type': 'application/json',
                },
                json={'client-id': self._client_id},
                timeout=10,
            )
        except Exception:
            pass

    def _run(self):
        try:
            url = f'{self._client.base_url}/api/v1/projects/{self._project_id}/listen'
            headers = {
                'Authorization': f'Bearer {self._client.token}',
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
            }
            if self._client.agent_name:
                headers['X-Agent-Name'] = self._client.agent_name

            self._response = requests.get(url, headers=headers, stream=True, timeout=None)
            self._response.raise_for_status()

            self._is_connected = True
            self._ready_state = 1  # OPEN

            event_type = ''
            data = ''

            for line in self._response.iter_lines(decode_unicode=True):
                if self._stop_event.is_set():
                    break

                if line is None:
                    continue

                if line.startswith('event: '):
                    event_type = line[7:].strip()
                elif line.startswith('data: '):
                    data = line[6:]
                elif line == '' and event_type and data:
                    try:
                        self._event_stats[event_type] = self._event_stats.get(event_type, 0) + 1

                        if event_type == 'connected':
                            parsed = json.loads(data)
                            self._client_id = parsed.get('client-id') or parsed.get('clientId')
                        elif event_type == 'heartbeat':
                            threading.Thread(target=self._send_heartbeat, daemon=True).start()
                        else:
                            parsed = json.loads(data)
                            should_stop = self._on_event(event_type, transform_response(parsed))
                            if should_stop is True:
                                self.close()
                                return
                    except Exception as e:
                        logger.warning('Failed to parse SSE event data: %s', e)

                    event_type = ''
                    data = ''

        except Exception as e:
            if not self._is_closed:
                logger.warning('SSE connection error: %s', e)
        finally:
            self._is_connected = False
            self._is_closed = True
            self._ready_state = 2  # CLOSED
