import json
import logging
import socket
import threading
import time

import requests

from plaid_client.transforms import transform_response

logger = logging.getLogger(__name__)


class SSEConnection:
    """SSE connection to the listen endpoint using streaming requests.

    Automatically handles heartbeat confirmations and event parsing. The
    connection runs on a background daemon thread, started in the constructor.

    Constructor args:
        client: PlaidClient instance.
        project_id: Project UUID.
        on_event: Callback (event_type, data). Return True to stop.

    The ``ready_state`` property mirrors the JS readyState values:
    0 (CONNECTING), 1 (OPEN), 2 (CLOSED).
    """

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
        """Current connection state: 0 CONNECTING, 1 OPEN, 2 CLOSED."""
        return self._ready_state

    def _abort_socket(self):
        """Shut down the underlying TCP socket so a read blocked in the reader
        thread's ``iter_lines()`` unblocks immediately.

        ``requests.Response.close()`` does NOT reliably wake a ``recv()`` that
        is blocked in another thread, so calling it while the reader sits idle
        between SSE events can hang until the next byte arrives.
        ``socket.shutdown()`` interrupts the blocked read at once. The socket's
        location inside urllib3 varies by version, so probe the known shapes
        and fall back silently."""
        resp = self._response
        raw = getattr(resp, 'raw', None)
        if raw is None:
            return
        try:
            conn = getattr(raw, '_connection', None)
            sock = getattr(conn, 'sock', None) if conn is not None else None
            if sock is None:
                inner = getattr(getattr(raw, '_fp', None), 'fp', None)
                sr = getattr(inner, 'raw', None)
                sock = getattr(sr, '_sock', None) if sr is not None else None
            if sock is not None:
                sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass

    def close(self):
        """Close the connection and abort the underlying stream."""
        if not self._is_closed:
            self._is_closed = True
            self._is_connected = False
            self._ready_state = 2  # CLOSED
            self._stop_event.set()
            # Unblock the reader's iter_lines() first, then release the
            # response — otherwise close() can hang waiting on the in-flight
            # blocking read.
            self._abort_socket()
            if self._response:
                try:
                    self._response.close()
                except Exception:
                    pass

    def get_stats(self):
        """Return connection statistics.

        Returns:
            A dict with ``duration_seconds``, ``is_connected``, ``is_closed``,
            ``client_id``, ``events`` (per-type event counts), and
            ``ready_state``.
        """
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
