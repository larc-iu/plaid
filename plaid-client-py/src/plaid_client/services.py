"""Service coordination: discovery + server-mediated request/response RPC.

All of this runs OFF the broadcast bus (`/listen` + `/message`). Discovery is a
synchronous read of the server-side registry. Work requests are addressed: a
service receives them on its own SSE channel and reports back via plain POSTs
that the server relays to the one waiting requester.
"""
import json
import logging
import threading

import requests

from plaid_client.sse import abort_response
from plaid_client.transforms import transform_request, transform_response

logger = logging.getLogger(__name__)


def discover_services(client, project_id, timeout=None):
    """Discover available services in a project — a synchronous read of the
    server-side registry. ``timeout`` is accepted for back-compat and ignored.
    """
    return client.messages.list_services(project_id)


def _report_event(client, project_id, request_id, body):
    """POST a progress/result/error event for an in-flight request; the server
    relays it to the waiting requester."""
    client.messages._request(
        'POST',
        f'/api/v1/projects/{project_id}/service-requests/{request_id}/events',
        body=body)


class ServiceRegistration:
    """Handle for a running service registration created by ``serve``.

    Holds the inbound request channel (SSE) the service receives work on, plus
    a background thread that re-registers in the discovery registry so the
    service stays listed by ``discover_services``.

    Attributes:
        service_info: The registered metadata
            (service_id, service_name, description, extras).
    """

    def __init__(self, service_info, connection, client=None, project_id=None,
                 service_id=None):
        self.service_info = service_info
        self._connection = connection
        self._client = client
        self._project_id = project_id
        self._service_id = service_id
        self._running = True
        self._stop_event = threading.Event()
        self._heartbeat_thread = None

    def _start_heartbeat(self, interval_s):
        """Spawn a daemon thread that re-registers every ``interval_s`` seconds
        to keep the discovery-registry entry live."""
        def loop():
            # `wait` returns True when stopped, False on timeout — so the loop
            # exits promptly on stop() instead of sleeping out the interval.
            while not self._stop_event.wait(timeout=interval_s):
                try:
                    self._client.messages.register_service(
                        self._project_id, self.service_info)
                except Exception:
                    logger.warning('Failed to send service heartbeat')

        self._heartbeat_thread = threading.Thread(target=loop, daemon=True)
        self._heartbeat_thread.start()

    def stop(self):
        """Stop serving: halt heartbeats, unregister from the registry, and
        close the request channel."""
        self._running = False
        self._stop_event.set()
        if self._client and self._project_id and self._service_id:
            try:
                self._client.messages.unregister_service(
                    self._project_id, self._service_id)
            except Exception:
                logger.warning('Failed to unregister service')
        if self._connection:
            self._connection.close()

    def is_running(self):
        """Return whether the service is still running."""
        return self._running


def serve(client, project_id, service_info, on_service_request, extras=None):
    """Register a service and handle incoming work requests.

    Registers in the discovery registry (so ``discover_services`` lists it) and
    opens the service's dedicated request channel. For each request, runs
    ``on_service_request(data, response_helper)`` where ``response_helper`` has
    ``progress(percent, msg)`` / ``complete(data)`` / ``error(err)``. The
    handler runs synchronously on the channel's reader thread (one request at a
    time), matching the previous behavior.

    Args:
        client: PlaidClient instance.
        project_id: Project UUID.
        service_info: Dict with service_id, service_name, description.
        on_service_request: Handler callback (data, response_helper).
        extras: Optional additional metadata.

    Returns:
        A ServiceRegistration with stop() and is_running().
    """
    if extras is None:
        extras = {}
    service_id = service_info['service_id']
    service_name = service_info['service_name']
    description = service_info.get('description', '')

    full_info = {'service_id': service_id, 'service_name': service_name,
                 'description': description, 'extras': extras}
    registration = ServiceRegistration(full_info, None, client=client,
                                       project_id=project_id, service_id=service_id)

    def on_event(event_type, event_data):
        if not registration._running:
            return True
        # The channel only carries `connected` (ignored) and `service_request`.
        if event_type != 'service_request' or not isinstance(event_data, dict):
            return
        req_id = event_data.get('request_id')
        if not req_id:
            return
        req_data = event_data.get('data')

        class ResponseHelper:
            """Helper passed to the request handler for replying."""

            def progress(self, percent, msg=''):
                """Send a progress update for the in-flight request."""
                try:
                    _report_event(client, project_id, req_id,
                                  {'status': 'progress',
                                   'progress': {'percent': percent, 'message': msg}})
                except Exception:
                    logger.warning('Failed to send progress update')

            def complete(self, data=None):
                """Send the final successful result for the request."""
                try:
                    _report_event(client, project_id, req_id,
                                  {'status': 'completed', 'data': data})
                except Exception:
                    logger.warning('Failed to send completion message')

            def error(self, error):
                """Send an error response for the request."""
                try:
                    _report_event(client, project_id, req_id,
                                  {'status': 'error', 'data': {'error': str(error)}})
                except Exception:
                    logger.warning('Failed to send error message')

        helper = ResponseHelper()
        try:
            on_service_request(req_data, helper)
        except Exception as e:
            helper.error(str(e))

    # Register for discovery, then open the dedicated inbound request channel.
    try:
        res = client.messages.register_service(project_id, full_info)
        interval_ms = (res or {}).get('heartbeat_interval_ms') or 30000
    except Exception:
        logger.warning('Failed to register service')
        interval_ms = 30000

    channel_path = f'/api/v1/projects/{project_id}/services/{service_id}/requests'
    try:
        connection = client.messages.listen(project_id, on_event, path=channel_path)
    except Exception as e:
        raise RuntimeError(f'Failed to open service channel: {e}')

    registration._connection = connection
    registration._start_heartbeat(interval_ms / 1000.0)
    return registration


def request_service(client, project_id, service_id, data, timeout=10.0, on_progress=None):
    """Submit work to a service and await its result.

    Streams the service's progress + result back over a single server-mediated
    response (no broadcast). ``timeout`` is in seconds. Raises ``RuntimeError``
    if no service is currently connected (503), if the service reports an error,
    or if the stream ends without a result; ``TimeoutError`` on timeout.
    ``on_progress``, if given, is called with each progress payload
    (``{'percent', 'message'}``).
    """
    url = f'{client.base_url}/api/v1/projects/{project_id}/services/{service_id}/requests'
    headers = {
        'Authorization': f'Bearer {client.token}',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    }
    body = transform_request(data) if data is not None else None
    try:
        resp = requests.post(url, headers=headers, json=body, stream=True, timeout=(10, None))
    except Exception as e:
        raise RuntimeError(f'Failed to submit service request: {e}')

    if resp.status_code == 503:
        resp.close()
        raise RuntimeError(f"No live service '{service_id}' on this project")
    if not resp.ok:
        detail = ''
        try:
            detail = resp.text
        except Exception:
            pass
        resp.close()
        raise RuntimeError(f'Service request failed: HTTP {resp.status_code} {detail}')

    result = {'value': None, 'error': None, 'resolved': False}
    done = threading.Event()

    def reader():
        event_type = ''
        data_buf = ''
        try:
            for line in resp.iter_lines(decode_unicode=True):
                if done.is_set():
                    break
                if line is None:
                    continue
                if line.startswith('event: '):
                    event_type = line[7:].strip()
                elif line.startswith('data: '):
                    data_buf = line[6:]
                elif line == '' and event_type and data_buf:
                    payload = transform_response(json.loads(data_buf))
                    if event_type == 'progress':
                        if on_progress:
                            try:
                                on_progress(payload.get('progress'))
                            except Exception:
                                pass
                    elif event_type == 'result':
                        result['value'] = payload.get('data')
                        result['resolved'] = True
                        done.set()
                        return
                    elif event_type == 'error':
                        result['error'] = payload.get('error') or 'Service request failed'
                        result['resolved'] = True
                        done.set()
                        return
                    event_type = ''
                    data_buf = ''
            if not result['resolved']:
                result['error'] = 'Service closed the connection without a result'
                done.set()
        except Exception as e:
            if not result['resolved']:
                result['error'] = f'Service request stream error: {e}'
                done.set()

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()

    finished = done.wait(timeout=timeout)
    # Tear down the stream (unblocks the reader's iter_lines immediately).
    abort_response(resp)
    try:
        resp.close()
    except Exception:
        pass

    if not finished:
        raise TimeoutError(f'Service request timed out after {timeout}s')
    if result['error']:
        raise RuntimeError(result['error'])
    return result['value']
