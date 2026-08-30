"""Service coordination: discovery + server-mediated request/response RPC.

All of this runs OFF the broadcast bus (`/listen` + `/message`). A service is
present exactly while its inbound request channel (SSE) is open — that channel
is the registration; there is no separate registry or heartbeat. Discovery is a
synchronous GET. Work requests are addressed: a service receives them on its
channel and reports back via plain POSTs that the server relays to the one
waiting requester.
"""
import json
import logging
import threading
import urllib.parse

import requests

from plaid_client.http import short_error
from plaid_client.sse import SSE_CONNECT_TIMEOUT_S, abort_response
from plaid_client.transforms import transform_request, transform_response

logger = logging.getLogger(__name__)

# How long to wait for a channel-open attempt to declare itself (headers back,
# or the attempt failed). Comfortably above the SSE connect timeout so a
# refused port settles well within it.
_OPEN_SETTLE_TIMEOUT_S = SSE_CONNECT_TIMEOUT_S + 5.0

# HTTP statuses that mean "this registration will never work as configured":
# a bad token, a token without write access to the project, a project that does
# not exist. Retrying those forever would hide an operator error, so they are
# raised out of `serve` instead. Everything else (the server being down or
# restarting, a 5xx, a 409 from an instance that has not let go yet) is
# transient, and the registration keeps retrying.
_PERMANENT_STATUSES = frozenset({400, 401, 403, 404, 405, 422})


class ServiceRegistrationError(RuntimeError):
    """A service registration failed for a reason retrying cannot fix (bad
    token, insufficient permissions, unknown project)."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def discover_services(client, project_id):
    """Discover the services seen on a project — a synchronous GET.

    Returns every service ever registered on the project: currently connected
    ones carry ``online: True``; previously-seen offline ones carry
    ``online: False`` plus a ``last_seen_at`` stamp. Callers that need a
    service they can actually submit work to should filter on ``online``.
    """
    return client.messages._request('GET', f'/api/v1/projects/{project_id}/services')


def discard_service(client, project_id, service_id):
    """Forget a previously-seen (offline) service: removes its row from the
    project's persistent registry. Maintainer-only; 409 if the service is
    currently connected (it would just re-register)."""
    return client.messages._request(
        'DELETE',
        f'/api/v1/projects/{project_id}/services/{urllib.parse.quote(service_id, safe="")}')


def _report_event(client, project_id, request_id, body):
    """POST a progress/result/error event for an in-flight request; the server
    relays it to the waiting requester."""
    client.messages._request(
        'POST',
        f'/api/v1/projects/{project_id}/service-requests/{request_id}/events',
        body=body)


def _error_status(error):
    """HTTP status behind a failed channel-open attempt, or None if it failed
    below HTTP (connection refused, timeout, DNS)."""
    return getattr(getattr(error, 'response', None), 'status_code', None)


def _error_summary(error):
    """Why a channel-open attempt failed, for the operator. A 409 gets its own
    wording because it is the one failure another OPERATOR causes."""
    if _error_status(error) == 409:
        return 'another instance of this service is already connected (409)'
    return short_error(error)


class ServiceRegistration:
    """Handle for a running service created by ``serve``.

    Holds the inbound request channel (SSE) the service receives work on.
    Holding that channel open IS the registration — there is no separate
    registry entry or heartbeat. A supervisor thread reopens the channel if it
    drops (e.g. the server restarted), so the service self-heals: a restarted
    server is picked up within a few seconds of coming back, with no need to
    restart the service.

    Attributes:
        service_info: The registered metadata
            (service_id, service_name, description, extras).
    """

    def __init__(self, service_info, connection, client=None, project_id=None,
                 service_id=None, open_channel=None, on_status=None):
        self.service_info = service_info
        self._connection = connection
        self._client = client
        self._project_id = project_id
        self._service_id = service_id
        self._open_channel = open_channel  # () -> SSEConnection, to (re)open the channel
        self._running = True
        self._stop_event = threading.Event()
        self._supervisor_thread = None
        # Last state REPORTED through `_on_status`, so an outage produces one
        # "lost" line and one "back" line however many retries it took.
        self._on_status = on_status
        self._connected = False
        self._ever_connected = False

    # --- status reporting ---------------------------------------------------

    def _report(self, event, detail=None):
        """Announce a connection-state transition to the owner (BaseService
        prints these). Never let a listener's failure disturb the supervisor."""
        if not self._on_status:
            return
        try:
            self._on_status(event, self._project_id, detail)
        except Exception:
            logger.debug('Service status listener raised', exc_info=True)

    def _note_connected(self):
        """Report a channel that is verifiably open. The first success is a
        registration. A later one (after the server went away and came back) is
        a reconnection, including the case where the very first attempt had to
        wait for a server that was not up yet."""
        if self._connected:
            return
        first = not self._ever_connected
        self._connected = True
        self._ever_connected = True
        self._report('registered' if first else 'reconnected')

    def _note_disconnected(self, detail):
        if not self._connected:
            return
        self._connected = False
        self._report('disconnected', detail)

    def _start_supervisor(self, check_interval_s=3.0):
        """Spawn a daemon thread that reopens the request channel whenever it
        drops (e.g. the server restarted). Reopening the channel re-registers
        the service server-side, so presence and reachability come back
        together.

        Each attempt is VERIFIED: the reopened stream is only treated (and
        reported) as connected once the server has actually answered it. An
        attempt made while the server is down settles as CLOSED within the
        connect timeout and the next tick tries again, indefinitely, so a
        service left running through an outage of any length still comes back."""
        def loop():
            while not self._stop_event.wait(timeout=check_interval_s):
                if not self._running:
                    break
                conn = self._connection
                # ready_state: 0 CONNECTING (an attempt is in flight, leave it
                # alone), 1 OPEN (nothing to do), 2 CLOSED (dropped or failed,
                # since stop() would have ended the loop via _stop_event).
                if conn is None or conn.ready_state != 2 or not self._open_channel:
                    continue
                self._note_disconnected(_error_summary(getattr(conn, 'error', None)))
                if not self._running:
                    break
                try:
                    self._connection = conn = self._open_channel()
                except Exception as e:
                    # The channel opener does not normally raise (it hands back
                    # a connection that settles asynchronously), so this is an
                    # unexpected local failure. Retry on the next tick.
                    logger.warning('Service channel reconnect failed for %s: %s',
                                   self._service_id, e)
                    continue
                settled = conn.wait_until_settled(timeout=_OPEN_SETTLE_TIMEOUT_S)
                if not self._running:
                    # stop() landed while this attempt was in flight, so it
                    # closed the connection this one replaced. Close ours too,
                    # or the service would stay registered server-side.
                    conn.close()
                    break
                if settled == 1:
                    self._note_connected()

        self._supervisor_thread = threading.Thread(target=loop, daemon=True)
        self._supervisor_thread.start()

    def stop(self):
        """Stop serving: close the request channel (which deregisters the
        service server-side)."""
        self._running = False
        self._stop_event.set()
        if self._connection:
            self._connection.close()

    def is_running(self):
        """Return whether the service is still running (it keeps running, and
        keeps retrying, while the server is unreachable)."""
        return self._running

    def is_connected(self):
        """Return whether the request channel is open RIGHT NOW, i.e. whether
        the server currently sees this service as online."""
        conn = self._connection
        return bool(self._running and conn is not None and conn.ready_state == 1)


def serve(client, project_id, service_info, on_service_request, extras=None,
          on_status=None):
    """Register a service and handle incoming work requests.

    Opens the service's dedicated request channel — which registers it for
    discovery (presence = open channel) — and handles work on it. For each
    request, runs
    ``on_service_request(data, response_helper)`` where ``response_helper`` has
    ``progress(percent, msg)`` / ``complete(data)`` / ``error(err)``. The
    handler runs synchronously on the channel's reader thread (one request at a
    time), matching the previous behavior.

    If ``extras`` declares ``delegation: True`` the server mints a short-lived
    token for whoever submits each request and the handler's ``data`` carries
    it as ``delegated_token``; build a ``PlaidClient`` on it to act as that
    user (their permissions, their name in the audit log). Readers may drive a
    delegating service; a plain one is writer-only.

    A server that is DOWN is not an error here: the returned registration keeps
    retrying (see :meth:`ServiceRegistration._start_supervisor`) and connects
    as soon as the server answers, so a service may be started before the
    server and survives any number of server restarts. Only a failure that
    retrying cannot fix (a bad token, no write access, an unknown project)
    raises :class:`ServiceRegistrationError`.

    Args:
        client: PlaidClient instance.
        project_id: Project UUID.
        service_info: Dict with service_id, service_name, description.
        on_service_request: Handler callback (data, response_helper).
        extras: Optional additional metadata.
        on_status: Optional callback ``(event, project_id, detail)`` for
            connection-state transitions, where event is ``'registered'``,
            ``'reconnected'``, ``'disconnected'`` or ``'waiting'``. Called once
            per transition, not once per retry.

    Returns:
        A ServiceRegistration with stop(), is_running() and is_connected().

    Raises:
        ServiceRegistrationError: the registration cannot succeed as
            configured (bad token, insufficient permissions, unknown project).
    """
    if extras is None:
        extras = {}
    service_id = service_info['service_id']
    service_name = service_info['service_name']
    description = service_info.get('description', '')

    full_info = {'service_id': service_id, 'service_name': service_name,
                 'description': description, 'extras': extras}
    registration = ServiceRegistration(full_info, None, client=client,
                                       project_id=project_id, service_id=service_id,
                                       on_status=on_status)

    # Discovery metadata rides the channel's query string — opening the channel
    # is the registration. Keep wire keys kebab-case (transform extras too) so
    # they round-trip like the rest of the API.
    params = {'service-name': service_name, 'description': description}
    if extras:
        params['extras'] = json.dumps(transform_request(extras))
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v})
    channel_path = f'/api/v1/projects/{project_id}/services/{service_id}/requests'
    if query:
        channel_path = f'{channel_path}?{query}'

    def open_channel():
        return client.messages.listen(project_id, on_event, path=channel_path)

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
        # A delegating service (extras ``delegation: True``) gets a short-lived
        # token for the REQUESTING user with each request; surface it beside
        # the payload so the handler can act as that user (BaseService turns it
        # into ``request_data['requester_client']``).
        delegated = event_data.get('delegated_token')
        if delegated and isinstance(req_data, dict):
            req_data = {**req_data, 'delegated_token': delegated}

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

    # Open the inbound request channel; this registers the service for
    # discovery (presence = open channel). The opener hands back a connection
    # whose fate is decided asynchronously, so wait for the verdict rather than
    # assuming an object means a live registration.
    try:
        connection = open_channel()
    except Exception as e:
        raise RuntimeError(f'Failed to open service channel: {e}')

    registration._connection = connection
    registration._open_channel = open_channel

    state = connection.wait_until_settled(timeout=_OPEN_SETTLE_TIMEOUT_S)
    if state == 2:
        error = connection.error
        status = _error_status(error)
        if status in _PERMANENT_STATUSES:
            raise ServiceRegistrationError(
                f"Cannot serve '{service_id}' on project {project_id}: "
                f'{_error_summary(error)}', status=status)
        # Transient: the server is down, restarting, or still holding a stale
        # registration. Hand back a registration that keeps trying.
        registration._report('waiting', _error_summary(error))
    elif state == 1:
        registration._note_connected()

    registration._start_supervisor()
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
    # Propagate an open logical operation (client.begin_operation) to the
    # service: its writes then fold under the requester's audit-log entry
    # (BaseService adopts the id around process_request).
    group = getattr(client, '_operation_group', None)
    if group is not None and isinstance(data, dict):
        data = {**data, 'operation_group': {'id': group['id'], 'message': group['message']}}
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
