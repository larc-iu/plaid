import logging
import threading
import time
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_counter = 0
_counter_lock = threading.Lock()


def generate_request_id():
    """Generate a unique request ID for service coordination."""
    global _counter
    with _counter_lock:
        _counter += 1
        count = _counter
    return f'req_{count}_{int(time.time() * 1000)}'


def create_service_message(type_, **data):
    """Create a service coordination message."""
    return {
        'type': type_,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        **data,
    }


def is_service_message(data):
    """Check if a message is a service coordination message."""
    return isinstance(data, dict) and bool(data.get('type')) and bool(data.get('timestamp'))


def discover_services(client, listen_fn, send_fn, project_id, timeout=3.0):
    """Discover available services in a project.

    ``timeout`` is in seconds (the JS client uses milliseconds). Collects
    service registrations for the full timeout window, then returns them.
    """
    request_id = generate_request_id()
    discovered = []
    connection = None

    def on_event(event_type, event_data):
        if event_type == 'message' and isinstance(event_data.get('data'), dict):
            message = event_data['data']
            if is_service_message(message):
                if message.get('type') == 'service_registration' and message.get('request_id') == request_id:
                    discovered.append({
                        'service_id': message.get('service_id'),
                        'service_name': message.get('service_name'),
                        'description': message.get('description'),
                        'timestamp': message.get('timestamp'),
                        'extras': message.get('extras', {}),
                    })

    try:
        connection = listen_fn(project_id, on_event)
    except Exception as e:
        raise RuntimeError(f'Cannot establish SSE connection: {e}')

    try:
        discovery_message = create_service_message('service_discovery', request_id=request_id)
        send_fn(project_id, discovery_message)
    except Exception as e:
        if connection:
            connection.close()
        raise RuntimeError(f'Failed to send discovery message: {e}')

    time.sleep(timeout)
    if connection:
        connection.close()
    return discovered


class ServiceRegistration:
    """Handle for a running service registration created by ``serve``.

    Attributes:
        service_info: The registered service metadata
            (service_id, service_name, description, extras).
    """

    def __init__(self, service_info, connection):
        self.service_info = service_info
        self._connection = connection
        self._running = True

    def stop(self):
        """Stop serving and close the underlying SSE connection."""
        self._running = False
        if self._connection:
            self._connection.close()

    def is_running(self):
        """Return whether the service is still running."""
        return self._running


def serve(client, listen_fn, send_fn, project_id, service_info, on_service_request, extras=None):
    """Register as a service and handle incoming requests.

    Note: timeouts elsewhere in this module are in seconds for the Python
    client (the JS client uses milliseconds).

    Args:
        client: PlaidClient instance.
        listen_fn: Bound messages-listen function.
        send_fn: Bound messages-send-message function.
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
    registration = ServiceRegistration(full_info, None)

    def on_event(event_type, event_data):
        if not registration._running:
            return True

        if event_type != 'message' or not isinstance(event_data.get('data'), dict):
            return
        message = event_data['data']
        if not is_service_message(message):
            return

        if message.get('type') == 'service_discovery':
            reg_msg = create_service_message(
                'service_registration',
                request_id=message.get('request_id'),
                service_id=service_id,
                service_name=service_name,
                description=description,
                extras=extras,
            )
            try:
                send_fn(project_id, reg_msg)
            except Exception:
                logger.warning('Failed to send discovery response')

        elif message.get('type') == 'service_request' and message.get('service_id') == service_id:
            req_id = message.get('request_id')
            try:
                # Send acknowledgment
                try:
                    send_fn(project_id, create_service_message(
                        'service_response', request_id=req_id, status='received'))
                except Exception:
                    pass

                # Create response helper
                class ResponseHelper:
                    """Helper passed to the request handler for replying."""

                    def progress(self, percent, msg=''):
                        """Send a progress update for the in-flight request."""
                        try:
                            send_fn(project_id, create_service_message(
                                'service_response', request_id=req_id, status='progress',
                                progress={'percent': percent, 'message': msg}))
                        except Exception:
                            logger.warning('Failed to send progress update')

                    def complete(self, data=None):
                        """Send the final successful result for the request."""
                        try:
                            send_fn(project_id, create_service_message(
                                'service_response', request_id=req_id, status='completed', data=data))
                        except Exception:
                            logger.warning('Failed to send completion message')

                    def error(self, error):
                        """Send an error response for the request."""
                        error_str = str(error)
                        try:
                            send_fn(project_id, create_service_message(
                                'service_response', request_id=req_id, status='error',
                                data={'error': error_str}))
                        except Exception:
                            logger.warning('Failed to send error message')

                helper = ResponseHelper()
                try:
                    on_service_request(message.get('data'), helper)
                except Exception as e:
                    helper.error(str(e))
            except Exception as e:
                try:
                    send_fn(project_id, create_service_message(
                        'service_response', request_id=req_id, status='error',
                        data={'error': str(e)}))
                except Exception:
                    logger.warning('Failed to send error response')

    try:
        connection = listen_fn(project_id, on_event)
    except Exception as e:
        raise RuntimeError(f'Failed to start service: {e}')

    registration._connection = connection
    return registration


def request_service(client, listen_fn, send_fn, project_id, service_id, data, timeout=10.0):
    """Send a request to a service and await its response.

    ``timeout`` is in seconds (the JS client uses milliseconds). Raises
    ``TimeoutError`` if no response arrives in time, or ``RuntimeError`` if the
    service responds with an error.
    """
    request_id = generate_request_id()
    connection = None
    result = {'value': None, 'error': None, 'resolved': False}
    done = threading.Event()

    def on_event(event_type, event_data):
        if event_type == 'message' and isinstance(event_data.get('data'), dict):
            message = event_data['data']
            if (is_service_message(message)
                    and message.get('type') == 'service_response'
                    and message.get('request_id') == request_id):
                if message.get('status') == 'completed':
                    if not result['resolved']:
                        result['resolved'] = True
                        result['value'] = message.get('data')
                        done.set()
                elif message.get('status') == 'error':
                    if not result['resolved']:
                        result['resolved'] = True
                        err = message.get('data', {})
                        result['error'] = err.get('error', 'Service request failed') if isinstance(err, dict) else 'Service request failed'
                        done.set()

    try:
        connection = listen_fn(project_id, on_event)
    except Exception as e:
        raise RuntimeError(f'Cannot establish SSE connection: {e}')

    try:
        req_msg = create_service_message('service_request',
                                         request_id=request_id, service_id=service_id, data=data)
        send_fn(project_id, req_msg)
    except Exception as e:
        if connection:
            connection.close()
        raise RuntimeError(f'Failed to send service request: {e}')

    done.wait(timeout=timeout)
    if connection:
        connection.close()

    if not result['resolved']:
        raise TimeoutError(f'Service request timed out after {timeout}s')
    if result['error']:
        raise RuntimeError(result['error'])
    return result['value']
