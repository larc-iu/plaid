import json
import logging
from urllib.parse import urlencode, quote

from plaid_client.transforms import transform_request, transform_response

logger = logging.getLogger(__name__)


class PlaidAPIError(Exception):
    def __init__(self, message, status=0, url='', method='', response_data=None):
        super().__init__(message)
        self.status = status
        self.url = url
        self.method = method
        self.response_data = response_data


def extract_document_versions(client, response_headers, response_body=None):
    header = response_headers.get('X-Document-Versions')
    if header:
        try:
            versions_map = json.loads(header)
            if isinstance(versions_map, dict):
                client.document_versions.update(versions_map)
        except (json.JSONDecodeError, TypeError):
            logger.warning('Failed to parse document versions header')

    if isinstance(response_body, dict):
        doc_id = response_body.get('document/id')
        doc_version = response_body.get('document/version')
        if doc_id and doc_version:
            client.document_versions[doc_id] = doc_version


def make_request(client, method, path, *, body=None, raw_body=None, form_data=False,
                 query_params=None, no_batch=False, skip_response_transform=False,
                 no_auth=False, binary_response=False):
    url = f'{client.base_url}{path}'

    # Append query params
    if query_params:
        filtered = {}
        for k, v in query_params.items():
            if v is None:
                continue
            # Booleans must be lowercase for the server's malli coercion
            if isinstance(v, bool):
                filtered[k] = 'true' if v else 'false'
            else:
                filtered[k] = v
        if filtered:
            url += '?' + urlencode(filtered)

    # Prepare request body
    request_body = None
    if form_data:
        request_body = body
    elif raw_body is not None:
        request_body = raw_body
    elif body is not None:
        request_body = transform_request(body)

    # Strict mode: append document-version for non-GET requests
    if client.strict_mode_document_id and method != 'GET':
        doc_id = client.strict_mode_document_id
        doc_version = client.document_versions.get(doc_id)
        if doc_version:
            separator = '&' if '?' in url else '?'
            url += f'{separator}document-version={quote(str(doc_version))}'

    # Batch mode
    if client.is_batching:
        if no_batch:
            raise PlaidAPIError(f'This endpoint cannot be used in batch mode: {path}')
        operation = {
            'path': url.replace(client.base_url, ''),
            'method': method.upper(),
        }
        if request_body is not None:
            operation['body'] = request_body
        client.batch_operations.append(operation)
        return {'batched': True}

    # Build request kwargs
    headers = {}
    if not no_auth:
        headers['Authorization'] = f'Bearer {client.token}'
    if not form_data:
        headers['Content-Type'] = 'application/json'
    if client.agent_name:
        headers['X-Agent-Name'] = client.agent_name

    kwargs = {'method': method, 'url': url, 'headers': headers}

    if request_body is not None:
        if form_data:
            # request_body is a dict of {field: file_tuple} for multipart
            kwargs.pop('headers', None)
            kwargs['headers'] = {k: v for k, v in headers.items() if k != 'Content-Type'}
            kwargs['files'] = request_body
        else:
            kwargs['data'] = json.dumps(request_body)

    try:
        response = client.session.request(**kwargs)
    except Exception as e:
        raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method=method)

    if not response.ok:
        try:
            error_data = response.json()
        except Exception:
            error_data = {'message': response.text}
        server_message = (error_data.get('error') or error_data.get('message')
                          or response.reason or 'Unknown error')
        raise PlaidAPIError(
            f'HTTP {response.status_code} {server_message} at {url}',
            status=response.status_code, url=url, method=method,
            response_data=error_data,
        )

    # Binary response
    if binary_response:
        extract_document_versions(client, response.headers)
        return response.content

    # JSON or text response
    content_type = response.headers.get('content-type', '')
    if 'application/json' in content_type:
        data = response.json()
        extract_document_versions(client, response.headers, data)
        if skip_response_transform:
            return data
        return transform_response(data)
    else:
        extract_document_versions(client, response.headers)
        return response.text
