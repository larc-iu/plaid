"""
plaid-api-v1 - Plaid's REST API
Version: v1.0
Generated on: Fri Jul 18 13:55:30 EDT 2025
"""

import requests
import aiohttp
import json
import time
from typing import Any, Dict, List, Optional, Union, Callable, Tuple, BinaryIO


class PlaidAPIError(Exception):
    """Custom exception for Plaid API errors with consistent interface"""
    
    def __init__(self, message: str, status: int, url: str, method: str, response_data: Any = None):
        super().__init__(message)
        self.status = status
        self.url = url
        self.method = method
        self.response_data = response_data
    
    def __str__(self):
        return self.args[0] if self.args else f"HTTP {self.status} at {self.url}"


class VocabLinksResource:
    """
    Resource class for vocabLinks operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, vocab_item: str, tokens: List[Any], metadata: Any = None) -> Any:
        """
        Create a new vocab link (link between tokens and vocab item).

        Args:
            vocab_item: Required body parameter
            tokens: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links"
        body_dict = {
            'vocab-item': vocab_item,
            'tokens': tokens,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, vocab_item: str, tokens: List[Any], metadata: Any = None) -> Any:
        """
        Create a new vocab link (link between tokens and vocab item).

        Args:
            vocab_item: Required body parameter
            tokens: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links"
        body_dict = {
            'vocab-item': vocab_item,
            'tokens': tokens,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def set_metadata(self, id: str, body: Any) -> Any:
        """
        Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, id: str, body: Any) -> Any:
        """
        Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, id: str) -> Any:
        """
        Remove all metadata from a vocab link.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, id: str) -> Any:
        """
        Remove all metadata from a vocab link.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, id: str, as_of: str = None) -> Any:
        """
        Get a vocab link by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, id: str, as_of: str = None) -> Any:
        """
        Get a vocab link by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, id: str) -> Any:
        """
        Delete a vocab link

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, id: str) -> Any:
        """
        Delete a vocab link

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-links/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )


class VocabLayersResource:
    """
    Resource class for vocabLayers operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def get(self, id: str, include_items: bool = None, as_of: str = None) -> Any:
        """
        Get a vocab layer by ID

        Args:
            id: Path parameter
            include_items: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        params = {}
        if include_items is not None:
            params['include-items'] = include_items
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, id: str, include_items: bool = None, as_of: str = None) -> Any:
        """
        Get a vocab layer by ID

        Args:
            id: Path parameter
            include_items: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        params = {}
        if include_items is not None:
            params['include-items'] = include_items
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, id: str) -> Any:
        """
        Delete a vocab layer.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, id: str) -> Any:
        """
        Delete a vocab layer.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, id: str, name: str) -> Any:
        """
        Update a vocab layer's name.

        Args:
            id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, id: str, name: str) -> Any:
        """
        Update a vocab layer's name.

        Args:
            id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def list(self, as_of: str = None) -> Any:
        """
        List all vocab layers accessible to user

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def list_async(self, as_of: str = None) -> Any:
        """
        List all vocab layers accessible to user

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def create(self, name: str) -> Any:
        """
        Create a new vocab layer. Note: this also registers the user as a maintainer.

        Args:
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, name: str) -> Any:
        """
        Create a new vocab layer. Note: this also registers the user as a maintainer.

        Args:
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this vocab layer.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def add_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this vocab layer.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this vocab layer.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def remove_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this vocab layer.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-layers/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )


class RelationsResource:
    """
    Resource class for relations operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_metadata(self, relation_id: str, body: Any) -> Any:
        """
        Replace all metadata for a relation. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            relation_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, relation_id: str, body: Any) -> Any:
        """
        Replace all metadata for a relation. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            relation_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, relation_id: str) -> Any:
        """
        Remove all metadata from a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, relation_id: str) -> Any:
        """
        Remove all metadata from a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def set_target(self, relation_id: str, span_id: str) -> Any:
        """
        Update the target span of a relation.

        Args:
            relation_id: Path parameter
            span_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/target"
        body_dict = {
            'span-id': span_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_target_async(self, relation_id: str, span_id: str) -> Any:
        """
        Update the target span of a relation.

        Args:
            relation_id: Path parameter
            span_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/target"
        body_dict = {
            'span-id': span_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def get(self, relation_id: str, as_of: str = None) -> Any:
        """
        Get a relation by ID.

        Args:
            relation_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, relation_id: str, as_of: str = None) -> Any:
        """
        Get a relation by ID.

        Args:
            relation_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, relation_id: str) -> Any:
        """
        Delete a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, relation_id: str) -> Any:
        """
        Delete a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, relation_id: str, value: Any) -> Any:
        """
        Update a relation's value.

        Args:
            relation_id: Path parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        body_dict = {
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, relation_id: str, value: Any) -> Any:
        """
        Update a relation's value.

        Args:
            relation_id: Path parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        body_dict = {
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def set_source(self, relation_id: str, span_id: str) -> Any:
        """
        Update the source span of a relation.

        Args:
            relation_id: Path parameter
            span_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/source"
        body_dict = {
            'span-id': span_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_source_async(self, relation_id: str, span_id: str) -> Any:
        """
        Update the source span of a relation.

        Args:
            relation_id: Path parameter
            span_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}/source"
        body_dict = {
            'span-id': span_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def create(self, layer_id: str, source_id: str, target_id: str, value: Any, metadata: Any = None) -> Any:
        """
        Create a new relation. A relation is a directed edge between two spans with a value, useful for expressing phenomena such as syntactic or semantic relations. A relation must at all times have both a valid source and target span. These spans must also belong to a single span layer which is linked to the relation's relation layer.

layer_id: the relation layer
source_id: the source span this relation originates from
target_id: the target span this relation goes to
<body>value</value>: the label for the relation

        Args:
            layer_id: Required body parameter
            source_id: Required body parameter
            target_id: Required body parameter
            value: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations"
        body_dict = {
            'layer-id': layer_id,
            'source-id': source_id,
            'target-id': target_id,
            'value': value,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, layer_id: str, source_id: str, target_id: str, value: Any, metadata: Any = None) -> Any:
        """
        Create a new relation. A relation is a directed edge between two spans with a value, useful for expressing phenomena such as syntactic or semantic relations. A relation must at all times have both a valid source and target span. These spans must also belong to a single span layer which is linked to the relation's relation layer.

layer_id: the relation layer
source_id: the source span this relation originates from
target_id: the target span this relation goes to
<body>value</value>: the label for the relation

        Args:
            layer_id: Required body parameter
            source_id: Required body parameter
            target_id: Required body parameter
            value: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations"
        body_dict = {
            'layer-id': layer_id,
            'source-id': source_id,
            'target-id': target_id,
            'value': value,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def bulk_create(self, body: List[Any]) -> Any:
        """
        Create multiple relations in a single operation. Provide an array of objects whose keysare:
relation_layer_id, the relation's layer
source, the span id of the relation's source
target, the span id of the relation's target
value, the relation's value
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def bulk_create_async(self, body: List[Any]) -> Any:
        """
        Create multiple relations in a single operation. Provide an array of objects whose keysare:
relation_layer_id, the relation's layer
source, the span id of the relation's source
target, the span id of the relation's target
value, the relation's value
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def bulk_delete(self, body: List[Any]) -> Any:
        """
        Delete multiple relations in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def bulk_delete_async(self, body: List[Any]) -> Any:
        """
        Delete multiple relations in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )


class SpanLayersResource:
    """
    Resource class for spanLayers operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_config(self, span_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            span_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, span_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            span_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, span_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            span_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, span_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            span_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, span_layer_id: str, as_of: str = None) -> Any:
        """
        Get a span layer by ID.

        Args:
            span_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, span_layer_id: str, as_of: str = None) -> Any:
        """
        Get a span layer by ID.

        Args:
            span_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, span_layer_id: str) -> Any:
        """
        Delete a span layer.

        Args:
            span_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, span_layer_id: str) -> Any:
        """
        Delete a span layer.

        Args:
            span_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, span_layer_id: str, name: str) -> Any:
        """
        Update a span layer's name.

        Args:
            span_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, span_layer_id: str, name: str) -> Any:
        """
        Update a span layer's name.

        Args:
            span_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def create(self, token_layer_id: str, name: str) -> Any:
        """
        Create a new span layer.

        Args:
            token_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers"
        body_dict = {
            'token-layer-id': token_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, token_layer_id: str, name: str) -> Any:
        """
        Create a new span layer.

        Args:
            token_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers"
        body_dict = {
            'token-layer-id': token_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def shift(self, span_layer_id: str, direction: str) -> Any:
        """
        Shift a span layer's order.

        Args:
            span_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def shift_async(self, span_layer_id: str, direction: str) -> Any:
        """
        Shift a span layer's order.

        Args:
            span_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class SpansResource:
    """
    Resource class for spans operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_tokens(self, span_id: str, tokens: List[Any]) -> Any:
        """
        Replace tokens for a span.

        Args:
            span_id: Path parameter
            tokens: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/tokens"
        body_dict = {
            'tokens': tokens
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_tokens_async(self, span_id: str, tokens: List[Any]) -> Any:
        """
        Replace tokens for a span.

        Args:
            span_id: Path parameter
            tokens: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/tokens"
        body_dict = {
            'tokens': tokens
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def create(self, span_layer_id: str, tokens: List[Any], value: Any, metadata: Any = None) -> Any:
        """
        Create a new span. A span holds a primary atomic value and optional metadata, and must at all times be associated with one or more tokens.

span_layer_id: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by span_layer_id.
value: the primary value of the span (must be string, number, boolean, or null).
metadata: optional key-value pairs for additional annotation data.

        Args:
            span_layer_id: Required body parameter
            tokens: Required body parameter
            value: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans"
        body_dict = {
            'span-layer-id': span_layer_id,
            'tokens': tokens,
            'value': value,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, span_layer_id: str, tokens: List[Any], value: Any, metadata: Any = None) -> Any:
        """
        Create a new span. A span holds a primary atomic value and optional metadata, and must at all times be associated with one or more tokens.

span_layer_id: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by span_layer_id.
value: the primary value of the span (must be string, number, boolean, or null).
metadata: optional key-value pairs for additional annotation data.

        Args:
            span_layer_id: Required body parameter
            tokens: Required body parameter
            value: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans"
        body_dict = {
            'span-layer-id': span_layer_id,
            'tokens': tokens,
            'value': value,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def get(self, span_id: str, as_of: str = None) -> Any:
        """
        Get a span by ID.

        Args:
            span_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, span_id: str, as_of: str = None) -> Any:
        """
        Get a span by ID.

        Args:
            span_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, span_id: str) -> Any:
        """
        Delete a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, span_id: str) -> Any:
        """
        Delete a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, span_id: str, value: Any) -> Any:
        """
        Update a span's value.

        Args:
            span_id: Path parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        body_dict = {
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, span_id: str, value: Any) -> Any:
        """
        Update a span's value.

        Args:
            span_id: Path parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        body_dict = {
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def bulk_create(self, body: List[Any]) -> Any:
        """
        Create multiple spans in a single operation. Provide an array of objects whose keysare:
span_layer_id, the span's layer
tokens, the IDs of the span's constituent tokens
value, the relation's value
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def bulk_create_async(self, body: List[Any]) -> Any:
        """
        Create multiple spans in a single operation. Provide an array of objects whose keysare:
span_layer_id, the span's layer
tokens, the IDs of the span's constituent tokens
value, the relation's value
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def bulk_delete(self, body: List[Any]) -> Any:
        """
        Delete multiple spans in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def bulk_delete_async(self, body: List[Any]) -> Any:
        """
        Delete multiple spans in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def set_metadata(self, span_id: str, body: Any) -> Any:
        """
        Replace all metadata for a span. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            span_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, span_id: str, body: Any) -> Any:
        """
        Replace all metadata for a span. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            span_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, span_id: str) -> Any:
        """
        Remove all metadata from a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, span_id: str) -> Any:
        """
        Remove all metadata from a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )


class BatchResource:
    """
    Resource class for batch operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def submit(self, body: List[Any]) -> Any:
        """
        Execute multiple API operations one after the other. If any operation fails (status >= 300), all changes are rolled back. Atomicity is guaranteed. On success, returns an array of each response associated with each submitted request in the batch. On failure, returns a single response map with the first failing response in the batch. 

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/batch"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/batch')
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def submit_async(self, body: List[Any]) -> Any:
        """
        Execute multiple API operations one after the other. If any operation fails (status >= 300), all changes are rolled back. Atomicity is guaranteed. On success, returns an array of each response associated with each submitted request in the batch. On failure, returns a single response map with the first failing response in the batch. 

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/batch"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/batch')
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class TextsResource:
    """
    Resource class for texts operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_metadata(self, text_id: str, body: Any) -> Any:
        """
        Replace all metadata for a text. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            text_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, text_id: str, body: Any) -> Any:
        """
        Replace all metadata for a text. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            text_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, text_id: str) -> Any:
        """
        Remove all metadata from a text.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, text_id: str) -> Any:
        """
        Remove all metadata from a text.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def create(self, text_layer_id: str, document_id: str, body: str, metadata: Any = None) -> Any:
        """
        Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

text_layer_id: the text's associated layer.
document_id: the text's associated document.
body: the string which is the content of this text.

        Args:
            text_layer_id: Required body parameter
            document_id: Required body parameter
            body: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts"
        body_dict = {
            'text-layer-id': text_layer_id,
            'document-id': document_id,
            'body': body,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, text_layer_id: str, document_id: str, body: str, metadata: Any = None) -> Any:
        """
        Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

text_layer_id: the text's associated layer.
document_id: the text's associated document.
body: the string which is the content of this text.

        Args:
            text_layer_id: Required body parameter
            document_id: Required body parameter
            body: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts"
        body_dict = {
            'text-layer-id': text_layer_id,
            'document-id': document_id,
            'body': body,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def get(self, text_id: str, as_of: str = None) -> Any:
        """
        Get a text.

        Args:
            text_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, text_id: str, as_of: str = None) -> Any:
        """
        Get a text.

        Args:
            text_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, text_id: str) -> Any:
        """
        Delete a text and all dependent data.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, text_id: str) -> Any:
        """
        Delete a text and all dependent data.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, text_id: str, body: str) -> Any:
        """
        Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.

        Args:
            text_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        body_dict = {
            'body': body
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, text_id: str, body: str) -> Any:
        """
        Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.

        Args:
            text_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        body_dict = {
            'body': body
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )


class UsersResource:
    """
    Resource class for users operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def list(self, as_of: str = None) -> Any:
        """
        List all users

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def list_async(self, as_of: str = None) -> Any:
        """
        List all users

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def create(self, username: str, password: str, is_admin: bool) -> Any:
        """
        Create a new user

        Args:
            username: Required body parameter
            password: Required body parameter
            is_admin: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/users"
        body_dict = {
            'username': username,
            'password': password,
            'is-admin': is_admin
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, username: str, password: str, is_admin: bool) -> Any:
        """
        Create a new user

        Args:
            username: Required body parameter
            password: Required body parameter
            is_admin: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/users"
        body_dict = {
            'username': username,
            'password': password,
            'is-admin': is_admin
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def audit(self, user_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a user's actions

        Args:
            user_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{user_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def audit_async(self, user_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a user's actions

        Args:
            user_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{user_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def get(self, id: str, as_of: str = None) -> Any:
        """
        Get a user by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, id: str, as_of: str = None) -> Any:
        """
        Get a user by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, id: str) -> Any:
        """
        Delete a user

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, id: str) -> Any:
        """
        Delete a user

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, id: str, password: str = None, username: str = None, is_admin: bool = None) -> Any:
        """
        Modify a user. Admins may change the username, password, and admin status of any user. All other users may only modify their own username or password.

        Args:
            id: Path parameter
            password: Optional body parameter
            username: Optional body parameter
            is_admin: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        body_dict = {
            'password': password,
            'username': username,
            'is-admin': is_admin
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, id: str, password: str = None, username: str = None, is_admin: bool = None) -> Any:
        """
        Modify a user. Admins may change the username, password, and admin status of any user. All other users may only modify their own username or password.

        Args:
            id: Path parameter
            password: Optional body parameter
            username: Optional body parameter
            is_admin: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        body_dict = {
            'password': password,
            'username': username,
            'is-admin': is_admin
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )


class TokenLayersResource:
    """
    Resource class for tokenLayers operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def shift(self, token_layer_id: str, direction: str) -> Any:
        """
        Shift a token layer's order.

        Args:
            token_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def shift_async(self, token_layer_id: str, direction: str) -> Any:
        """
        Shift a token layer's order.

        Args:
            token_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def create(self, text_layer_id: str, name: str) -> Any:
        """
        Create a new token layer.

        Args:
            text_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers"
        body_dict = {
            'text-layer-id': text_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, text_layer_id: str, name: str) -> Any:
        """
        Create a new token layer.

        Args:
            text_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers"
        body_dict = {
            'text-layer-id': text_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def set_config(self, token_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            token_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, token_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            token_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, token_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            token_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, token_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            token_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, token_layer_id: str, as_of: str = None) -> Any:
        """
        Get a token layer by ID.

        Args:
            token_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, token_layer_id: str, as_of: str = None) -> Any:
        """
        Get a token layer by ID.

        Args:
            token_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, token_layer_id: str) -> Any:
        """
        Delete a token layer.

        Args:
            token_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, token_layer_id: str) -> Any:
        """
        Delete a token layer.

        Args:
            token_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, token_layer_id: str, name: str) -> Any:
        """
        Update a token layer's name.

        Args:
            token_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, token_layer_id: str, name: str) -> Any:
        """
        Update a token layer's name.

        Args:
            token_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )


class DocumentsResource:
    """
    Resource class for documents operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def check_lock(self, document_id: str, as_of: str = None) -> Any:
        """
        Get information about a document lock

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def check_lock_async(self, document_id: str, as_of: str = None) -> Any:
        """
        Get information about a document lock

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def acquire_lock(self, document_id: str) -> Any:
        """
        Acquire or refresh a document lock

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def acquire_lock_async(self, document_id: str) -> Any:
        """
        Acquire or refresh a document lock

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def release_lock(self, document_id: str) -> Any:
        """
        Release a document lock

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def release_lock_async(self, document_id: str) -> Any:
        """
        Release a document lock

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/lock"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get_media(self, document_id: str, as_of: str = None) -> Any:
        """
        Get media file for a document

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            # Return raw binary content for media downloads
            return response.content
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_media_async(self, document_id: str, as_of: str = None) -> Any:
        """
        Get media file for a document

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    # Return raw binary content for media downloads
                    return await response.read()
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def upload_media(self, document_id: str, file: Union[BinaryIO, str, Tuple[str, BinaryIO]]) -> Any:
        """
        Upload a media file for a document. Uses Apache Tika for content validation.

        Args:
            document_id: Path parameter
            file: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        files_dict = {
            'file': file
        }
        # Filter out None values
        files_data = {k: v for k, v in files_dict.items() if v is not None}

        
        headers = {}  # Don't set Content-Type for multipart, let requests handle it
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            response = requests.put(url, files=files_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def upload_media_async(self, document_id: str, file: Union[BinaryIO, str, Tuple[str, BinaryIO]]) -> Any:
        """
        Upload a media file for a document. Uses Apache Tika for content validation.

        Args:
            document_id: Path parameter
            file: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        files_dict = {
            'file': file
        }
        # Filter out None values
        files_data = {k: v for k, v in files_dict.items() if v is not None}

        
        headers = {}  # Don't set Content-Type for multipart, let requests handle it
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, data=files_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_media(self, document_id: str) -> Any:
        """
        Delete media file for a document

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_media_async(self, document_id: str) -> Any:
        """
        Delete media file for a document

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/media"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/documents/{document-id}/media')
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def set_metadata(self, document_id: str, body: Any) -> Any:
        """
        Replace all metadata for a document. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            document_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, document_id: str, body: Any) -> Any:
        """
        Replace all metadata for a document. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            document_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, document_id: str) -> Any:
        """
        Remove all metadata from a document.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, document_id: str) -> Any:
        """
        Remove all metadata from a document.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def audit(self, document_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a document

        Args:
            document_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def audit_async(self, document_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a document

        Args:
            document_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def get(self, document_id: str, include_body: bool = None, as_of: str = None) -> Any:
        """
        Get a document. Set include_body to true in order to include all data contained in the document.

        Args:
            document_id: Path parameter
            include_body: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        params = {}
        if include_body is not None:
            params['include-body'] = include_body
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, document_id: str, include_body: bool = None, as_of: str = None) -> Any:
        """
        Get a document. Set include_body to true in order to include all data contained in the document.

        Args:
            document_id: Path parameter
            include_body: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        params = {}
        if include_body is not None:
            params['include-body'] = include_body
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, document_id: str) -> Any:
        """
        Delete a document and all data contained.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, document_id: str) -> Any:
        """
        Delete a document and all data contained.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, document_id: str, name: str) -> Any:
        """
        Update a document. Supported keys:

name: update a document's name.

        Args:
            document_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, document_id: str, name: str) -> Any:
        """
        Update a document. Supported keys:

name: update a document's name.

        Args:
            document_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def create(self, project_id: str, name: str, metadata: Any = None) -> Any:
        """
        Create a new document in a project. Requires project_id and name.

        Args:
            project_id: Required body parameter
            name: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents"
        body_dict = {
            'project-id': project_id,
            'name': name,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, project_id: str, name: str, metadata: Any = None) -> Any:
        """
        Create a new document in a project. Requires project_id and name.

        Args:
            project_id: Required body parameter
            name: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents"
        body_dict = {
            'project-id': project_id,
            'name': name,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class MessagesResource:
    """
    Resource class for messages operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def send_message(self, id: str, body: Any) -> Any:
        """
        Send a message to all clients that are listening to a project. Useful for e.g. telling an NLP service to perform some work.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/message"
        body_data = {'body': body}
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def send_message_async(self, id: str, body: Any) -> Any:
        """
        Send a message to all clients that are listening to a project. Useful for e.g. telling an NLP service to perform some work.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/message"
        body_data = {'body': body}
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def heartbeat(self, id: str, client_id: str) -> Any:
        """
        INTERNAL, do not use directly.

        Args:
            id: Path parameter
            client_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/heartbeat"
        body_dict = {
            'client-id': client_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/projects/{id}/heartbeat')
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def heartbeat_async(self, id: str, client_id: str) -> Any:
        """
        INTERNAL, do not use directly.

        Args:
            id: Path parameter
            client_id: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/heartbeat"
        body_dict = {
            'client-id': client_id
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            raise ValueError('This endpoint cannot be used in batch mode: /api/v1/projects/{id}/heartbeat')
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def listen(self, id: str, on_event: Callable[[str, Dict[str, Any]], Optional[bool]]) -> Dict[str, Any]:
        """
        Listen to audit log events and messages for a project via Server-Sent Events (with enhanced connection management)
        
        Args:
            id: The UUID of the project to listen to
            on_event: Callback function that receives (event_type: str, data: dict). 
                     Returns True to stop listening, False/None to continue.
                     Heartbeat events are automatically handled.
            
        Returns:
            Dict[str, Any]: Connection statistics and session summary
        """
        import requests
        import json
        import time
        import threading
        
        url = f"{self.client.base_url}/api/v1/projects/{id}/listen"
        headers = {
            'Authorization': f'Bearer {self.client.token}',
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        
        session = requests.Session()
        session.headers.update(headers)
        
        # Connection state tracking (similar to JavaScript implementation)
        start_time = time.time()
        is_connected = False
        is_closed = False
        client_id = None
        
        # Event statistics (comprehensive like JavaScript)
        event_stats = {
            'audit-log': 0,
            'message': 0,
            'heartbeat': 0,
            'connected': 0,
            'other': 0
        }
        
        # Heartbeat tracking
        heartbeat_confirmations_sent = 0
        last_heartbeat = start_time
        
        def send_heartbeat_confirmation(client_id: str):
            """Send heartbeat confirmation to server (thread-safe)"""
            nonlocal heartbeat_confirmations_sent
            try:
                heartbeat_url = f"{self.client.base_url}/api/v1/projects/{id}/heartbeat"
                heartbeat_response = session.post(
                    heartbeat_url,
                    json={'client-id': client_id},
                    headers={'Content-Type': 'application/json'},
                    timeout=5.0  # Short timeout for heartbeat
                )
                if heartbeat_response.status_code == 200:
                    heartbeat_confirmations_sent += 1
            except Exception as e:
                # Log heartbeat confirmation failures but don't break connection
                print(f"Warning: Failed to confirm heartbeat: {e}")
        
        def get_connection_stats():
            """Get real-time connection statistics (similar to JavaScript getStats())"""
            return {
                'duration_seconds': time.time() - start_time,
                'is_connected': is_connected,
                'is_closed': is_closed,
                'client_id': client_id,
                'events': event_stats.copy(),
                'heartbeat_confirmations_sent': heartbeat_confirmations_sent,
                'last_heartbeat_seconds_ago': time.time() - last_heartbeat if event_stats['heartbeat'] > 0 else None,
                'connection_state': 'closed' if is_closed else ('connected' if is_connected else 'connecting')
            }
        
        try:
            with session.get(url, stream=True, timeout=None) as response:
                response.raise_for_status()
                
                is_connected = True
                
                # Parse SSE stream with enhanced error handling
                event_type = None
                data_buffer = ''
                
                for line in response.iter_lines(decode_unicode=True, chunk_size=None):
                    if is_closed:
                        break
                    
                    if line is not None:  # Handle None lines from iter_lines
                        line = line.strip()
                        
                        if line.startswith('event: '):
                            event_type = line[7:].strip()
                        elif line.startswith('data: '):
                            data_buffer = line[6:].strip()
                        elif line == '' and event_type and data_buffer:
                            # Complete SSE message received
                            try:
                                # Track event statistics
                                event_stats[event_type] = event_stats.get(event_type, 0) + 1
                                if event_type not in event_stats:
                                    event_stats['other'] += 1
                                
                                # Parse JSON data only if it looks like JSON
                                if (data_buffer and 
                                    (data_buffer.startswith('{') or 
                                     data_buffer.startswith('[') or 
                                     data_buffer.startswith('"'))):
                                    
                                    data = json.loads(data_buffer)
                                    
                                    # Handle specific event types
                                    if event_type == 'connected':
                                        client_id = data.get('client-id') or data.get('clientId')
                                    elif event_type == 'heartbeat':
                                        last_heartbeat = time.time()
                                        if client_id:
                                            # Send heartbeat confirmation in background thread
                                            threading.Thread(
                                                target=send_heartbeat_confirmation,
                                                args=(client_id,),
                                                daemon=True
                                            ).start()
                                    else:
                                        # Pass event to user callback (audit-log, message, etc.)
                                        transformed_data = self.client._transform_response(data)
                                        try:
                                            should_stop = on_event(event_type, transformed_data)
                                            if should_stop is True:
                                                is_closed = True
                                                break
                                        except Exception as e:
                                            # Log callback failures but continue listening
                                            print(f"Warning: Failed to execute SSE event callback: {e}")
                                else:
                                    # Skip non-JSON data or malformed content - but log if unexpected
                                    if data_buffer.strip():
                                        print(f"Warning: Failed to parse non-JSON SSE data: {data_buffer[:100]}...")
                                    
                            except json.JSONDecodeError as e:
                                # Log malformed JSON data
                                print(f"Warning: Failed to parse SSE JSON data: {e} - Data: {data_buffer[:100]}...")
                            except Exception as e:
                                # Log any other parsing errors
                                print(f"Warning: Failed to parse SSE data: {e}")
                            finally:
                                # Reset for next message
                                event_type = None
                                data_buffer = ''
        
        except requests.exceptions.RequestException as e:
            # Expected connection errors when closing/timing out - log for debugging
            print(f"Info: SSE connection ended: {e}")
        except Exception as e:
            # Log any other unexpected errors
            print(f"Error: Failed with unexpected SSE error: {e}")
        finally:
            is_connected = False
            is_closed = True
            session.close()
        
        # Return comprehensive session summary
        return get_connection_stats()
    def _generate_request_id(self) -> str:
        """Generate a unique request ID for tracking service coordination"""
        import uuid
        import time
        return f"req_{uuid.uuid4().hex[:8]}_{int(time.time() * 1000)}"
    
    def _create_service_message(self, msg_type: str, **data) -> Dict[str, Any]:
        """Create a structured service message with timestamp"""
        from datetime import datetime
        return {
            'type': msg_type,
            'timestamp': f"{datetime.utcnow().isoformat()}Z",
            **data
        }
    
    def _is_service_message(self, data: Any) -> bool:
        """Check if data is a structured service message"""
        return (isinstance(data, dict) and 
                'type' in data and 
                'timestamp' in data)
    
    def discover_services(self, project_id: str, timeout: int = 3000) -> List[Dict[str, Any]]:
        """
        Discover available services in a project
        
        Sends a service discovery request and collects responses from all
        registered services within the timeout period.
        
        Args:
            project_id: The UUID of the project to query
            timeout: Timeout in milliseconds (default: 3000)
            
        Returns:
            List of discovered service information dictionaries
        """
        import threading
        import time
        
        request_id = self._generate_request_id()
        discovered_services = []
        discovery_complete = threading.Event()
        connection_active = threading.Event()
        
        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:
            if event_type == 'message' and self._is_service_message(event_data.get('data')):
                message = event_data['data']
                
                if (message.get('type') == 'service_registration' and 
                    message.get('requestId') == request_id):
                    discovered_services.append({
                        'service_id': message.get('serviceId'),
                        'service_name': message.get('serviceName'),
                        'description': message.get('description'),
                        'timestamp': message.get('timestamp')
                    })
            
            # Check if we should stop listening
            if discovery_complete.is_set():
                return True
            return None
        
        # Start listening in a separate thread
        def listen_thread():
            try:
                connection_active.set()
                self.listen(project_id, on_event)
            except Exception as e:
                # Connection errors are expected when timing out
                print(f"Info: Service discovery connection ended: {e}")
        
        thread = threading.Thread(target=listen_thread, daemon=True)
        thread.start()
        
        # Wait for connection to be established
        connection_active.wait(timeout=1.0)
        
        if connection_active.is_set():
            # Send discovery request
            discovery_message = self._create_service_message('service_discovery', requestId=request_id)
            try:
                self.send_message(project_id, discovery_message)
            except Exception as e:
                # If send fails, mark discovery as complete
                discovery_complete.set()
                raise RuntimeError(f'Failed to send discovery message: {str(e)}')
        else:
            raise RuntimeError('Failed to establish SSE connection for service discovery')
        
        # Wait for timeout
        time.sleep(timeout / 1000.0)
        discovery_complete.set()
        
        return discovered_services
    
    def serve(self, project_id: str, service_info: Dict[str, str], on_service_request: Callable[[Dict[str, Any], Any], None]) -> Dict[str, Any]:
        """
        Register as a service and handle incoming requests
        
        Starts a service that responds to discovery requests and handles
        service requests with the provided callback function.
        
        Args:
            project_id: The UUID of the project to serve
            service_info: Dict with serviceId, serviceName, description
            on_service_request: Callback to handle service requests (data, response_helper)
            
        Returns:
            Service registration object with stop(), is_running(), service_info
        """
        import threading
        
        service_id = service_info['serviceId']
        service_name = service_info['serviceName']
        description = service_info['description']
        
        is_running = threading.Event()
        is_running.set()
        
        class ResponseHelper:
            """Helper class for sending service responses"""
            def __init__(self, request_id: str, messages_client, project_id: str):
                self.request_id = request_id
                self.messages_client = messages_client
                self.project_id = project_id
            
            def progress(self, percent: int, message: str):
                """Send progress update"""
                progress_msg = self.messages_client._create_service_message('service_response',
                    requestId=self.request_id,
                    status='progress',
                    progress={'percent': percent, 'message': message}
                )
                try:
                    self.messages_client.send_message(self.project_id, progress_msg)
                except Exception as e:
                    # Log send failures for progress updates
                    print(f"Warning: Failed to send progress update: {e}")
            
            def complete(self, data: Any):
                """Send completion response with result data"""
                completion_msg = self.messages_client._create_service_message('service_response',
                    requestId=self.request_id,
                    status='completed',
                    data=data
                )
                try:
                    self.messages_client.send_message(self.project_id, completion_msg)
                except Exception as e:
                    # Log send failures for completion
                    print(f"Warning: Failed to send completion response: {e}")
            
            def error(self, error: str):
                """Send error response"""
                error_msg = self.messages_client._create_service_message('service_response',
                    requestId=self.request_id,
                    status='error',
                    data={'error': error}
                )
                try:
                    self.messages_client.send_message(self.project_id, error_msg)
                except Exception as e:
                    # Log send failures for errors
                    print(f"Warning: Failed to send error response: {e}")
        
        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:
            if not is_running.is_set():
                return True  # Stop listening
            
            if event_type == 'message' and self._is_service_message(event_data.get('data')):
                message = event_data['data']
                
                if message.get('type') == 'service_discovery':
                    # Respond to service discovery
                    registration_msg = self._create_service_message('service_registration',
                        requestId=message.get('requestId'),
                        serviceId=service_id,
                        serviceName=service_name,
                        description=description
                    )
                    try:
                        self.send_message(project_id, registration_msg)
                    except Exception as e:
                        # Log send failures during discovery
                        print(f"Warning: Failed to send discovery response: {e}")
                
                elif (message.get('type') == 'service_request' and 
                      message.get('serviceId') == service_id):
                    # Handle service request
                    try:
                        # Send acknowledgment
                        ack_msg = self._create_service_message('service_response',
                            requestId=message.get('requestId'),
                            status='received'
                        )
                        try:
                            self.send_message(project_id, ack_msg)
                        except Exception as e:
                            # Log ack failures but continue
                            print(f"Warning: Failed to send acknowledgment: {e}")
                        
                        # Create response helper
                        response_helper = ResponseHelper(message.get('requestId'), self, project_id)
                        
                        # Call user handler in a separate thread to avoid blocking
                        def handle_request():
                            try:
                                on_service_request(message.get('data'), response_helper)
                            except Exception as e:
                                response_helper.error(str(e))
                        
                        handler_thread = threading.Thread(target=handle_request, daemon=True)
                        handler_thread.start()
                        
                    except Exception as e:
                        # Send error response
                        try:
                            error_msg = self._create_service_message('service_response',
                                requestId=message.get('requestId'),
                                status='error',
                                data={'error': str(e)}
                            )
                            self.send_message(project_id, error_msg)
                        except Exception as e:
                            # Log errors when sending error responses
                            print(f"Warning: Failed to send error response during serve: {e}")
        
        # Start service in a separate thread
        def service_thread():
            self.listen(project_id, on_event)
        
        thread = threading.Thread(target=service_thread, daemon=True)
        thread.start()
        
        service_registration = {
            'stop': lambda: is_running.clear(),
            'isRunning': lambda: is_running.is_set(),
            'service_info': {
                'service_id': service_id, 
                'service_name': service_name, 
                'description': description
            }
        }
        
        return service_registration
    
    def request_service(self, project_id: str, service_id: str, data: Any, timeout: int = 10000) -> Any:
        """
        Request a service to perform work
        
        Sends a service request and waits for completion or error response.
        Supports progress updates during long-running operations.
        
        Args:
            project_id: The UUID of the project
            service_id: The ID of the service to request
            data: The request data to send to the service
            timeout: Timeout in milliseconds (default: 10000)
            
        Returns:
            The response data from the service
            
        Raises:
            TimeoutError: If the request times out
            Exception: If the service returns an error
        """
        import threading
        import time
        
        request_id = self._generate_request_id()
        response_data = {'result': None, 'error': None, 'completed': False}
        response_event = threading.Event()
        connection_active = threading.Event()
        
        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:
            if event_type == 'message' and self._is_service_message(event_data.get('data')):
                message = event_data['data']
                
                if (message.get('type') == 'service_response' and 
                    message.get('requestId') == request_id):
                    
                    if message.get('status') == 'completed':
                        response_data['result'] = message.get('data')
                        response_data['completed'] = True
                        response_event.set()
                        return True  # Stop listening
                    elif message.get('status') == 'error':
                        response_data['error'] = message.get('data', {}).get('error', 'Service request failed')
                        response_data['completed'] = True
                        response_event.set()
                        return True  # Stop listening
                    # Ignore 'received' and 'progress' status messages (continue listening)
            
            # Check if we've timed out
            if response_event.is_set():
                return True
            return None
        
        # Start listening in a separate thread
        def listen_thread():
            try:
                connection_active.set()
                self.listen(project_id, on_event)
            except Exception as e:
                # Connection timeouts or errors are expected during request handling
                print(f"Info: Service request connection ended: {e}")
        
        thread = threading.Thread(target=listen_thread, daemon=True)
        thread.start()
        
        # Wait for connection to be established
        connection_active.wait(timeout=1.0)
        
        if connection_active.is_set():
            # Send service request
            request_message = self._create_service_message('service_request',
                requestId=request_id,
                serviceId=service_id,
                data=data
            )
            try:
                self.send_message(project_id, request_message)
            except Exception as e:
                raise RuntimeError(f'Failed to send service request: {str(e)}')
        else:
            raise RuntimeError('Failed to establish connection for service request')
        
        # Wait for response or timeout
        if response_event.wait(timeout / 1000.0):
            if response_data['error']:
                raise Exception(response_data['error'])
            return response_data['result']
        else:
            raise TimeoutError(f'Service request timed out after {timeout}ms')


class ProjectsResource:
    """
    Resource class for projects operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def add_writer(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read and write for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def add_writer_async(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read and write for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def remove_writer(self, id: str, user_id: str) -> Any:
        """
        Remove a user's writer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def remove_writer_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's writer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def add_reader(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read-only for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def add_reader_async(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read-only for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def remove_reader(self, id: str, user_id: str) -> Any:
        """
        Remove a user's reader privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def remove_reader_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's reader privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def add_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def remove_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def audit(self, project_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a project

        Args:
            project_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{project_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def audit_async(self, project_id: str, start_time: str = None, end_time: str = None, as_of: str = None) -> Any:
        """
        Get audit log for a project

        Args:
            project_id: Path parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{project_id}/audit"
        params = {}
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def link_vocab(self, id: str, vocab_id: str) -> Any:
        """
        Link a vocabulary to a project.

        Args:
            id: Path parameter
            vocab_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/vocabs/{vocab_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def link_vocab_async(self, id: str, vocab_id: str) -> Any:
        """
        Link a vocabulary to a project.

        Args:
            id: Path parameter
            vocab_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/vocabs/{vocab_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def unlink_vocab(self, id: str, vocab_id: str) -> Any:
        """
        Unlink a vocabulary to a project.

        Args:
            id: Path parameter
            vocab_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/vocabs/{vocab_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def unlink_vocab_async(self, id: str, vocab_id: str) -> Any:
        """
        Unlink a vocabulary to a project.

        Args:
            id: Path parameter
            vocab_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/vocabs/{vocab_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, id: str, include_documents: bool = None, as_of: str = None) -> Any:
        """
        Get a project by ID. If include_documents is true, also include document IDs and names.

        Args:
            id: Path parameter
            include_documents: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        params = {}
        if include_documents is not None:
            params['include-documents'] = include_documents
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, id: str, include_documents: bool = None, as_of: str = None) -> Any:
        """
        Get a project by ID. If include_documents is true, also include document IDs and names.

        Args:
            id: Path parameter
            include_documents: Optional query parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        params = {}
        if include_documents is not None:
            params['include-documents'] = include_documents
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, id: str) -> Any:
        """
        Delete a project.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, id: str) -> Any:
        """
        Delete a project.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, id: str, name: str) -> Any:
        """
        Update a project's name.

        Args:
            id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, id: str, name: str) -> Any:
        """
        Update a project's name.

        Args:
            id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def list(self, as_of: str = None) -> Any:
        """
        List all projects accessible to user

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def list_async(self, as_of: str = None) -> Any:
        """
        List all projects accessible to user

        Args:
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def create(self, name: str) -> Any:
        """
        Create a new project. Note: this also registers the user as a maintainer.

        Args:
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, name: str) -> Any:
        """
        Create a new project. Note: this also registers the user as a maintainer.

        Args:
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/projects"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class TextLayersResource:
    """
    Resource class for textLayers operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_config(self, text_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            text_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, text_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            text_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, text_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            text_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, text_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            text_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, text_layer_id: str, as_of: str = None) -> Any:
        """
        Get a text layer by ID.

        Args:
            text_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, text_layer_id: str, as_of: str = None) -> Any:
        """
        Get a text layer by ID.

        Args:
            text_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, text_layer_id: str) -> Any:
        """
        Delete a text layer.

        Args:
            text_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, text_layer_id: str) -> Any:
        """
        Delete a text layer.

        Args:
            text_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, text_layer_id: str, name: str) -> Any:
        """
        Update a text layer's name.

        Args:
            text_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, text_layer_id: str, name: str) -> Any:
        """
        Update a text layer's name.

        Args:
            text_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def shift(self, text_layer_id: str, direction: str) -> Any:
        """
        Shift a text layer's order within the project.

        Args:
            text_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def shift_async(self, text_layer_id: str, direction: str) -> Any:
        """
        Shift a text layer's order within the project.

        Args:
            text_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def create(self, project_id: str, name: str) -> Any:
        """
        Create a new text layer for a project.

        Args:
            project_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers"
        body_dict = {
            'project-id': project_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, project_id: str, name: str) -> Any:
        """
        Create a new text layer for a project.

        Args:
            project_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers"
        body_dict = {
            'project-id': project_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class LoginResource:
    """
    Resource class for login operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, user_id: str, password: str) -> Any:
        """
        Authenticate with a user_id and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.

        Args:
            user_id: Required body parameter
            password: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/login"
        body_dict = {
            'user-id': user_id,
            'password': password
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, user_id: str, password: str) -> Any:
        """
        Authenticate with a user_id and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.

        Args:
            user_id: Required body parameter
            password: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/login"
        body_dict = {
            'user-id': user_id,
            'password': password
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )


class VocabItemsResource:
    """
    Resource class for vocabItems operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def set_metadata(self, id: str, body: Any) -> Any:
        """
        Replace all metadata for a vocab item. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, id: str, body: Any) -> Any:
        """
        Replace all metadata for a vocab item. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, id: str) -> Any:
        """
        Remove all metadata from a vocab item.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, id: str) -> Any:
        """
        Remove all metadata from a vocab item.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def create(self, vocab_layer_id: str, form: str, metadata: Any = None) -> Any:
        """
        Create a new vocab item

        Args:
            vocab_layer_id: Required body parameter
            form: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items"
        body_dict = {
            'vocab-layer-id': vocab_layer_id,
            'form': form,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, vocab_layer_id: str, form: str, metadata: Any = None) -> Any:
        """
        Create a new vocab item

        Args:
            vocab_layer_id: Required body parameter
            form: Required body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items"
        body_dict = {
            'vocab-layer-id': vocab_layer_id,
            'form': form,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def get(self, id: str, as_of: str = None) -> Any:
        """
        Get a vocab item by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, id: str, as_of: str = None) -> Any:
        """
        Get a vocab item by ID

        Args:
            id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, id: str) -> Any:
        """
        Delete a vocab item

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, id: str) -> Any:
        """
        Delete a vocab item

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, id: str, form: str) -> Any:
        """
        Update a vocab item's form

        Args:
            id: Path parameter
            form: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        body_dict = {
            'form': form
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, id: str, form: str) -> Any:
        """
        Update a vocab item's form

        Args:
            id: Path parameter
            form: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/vocab-items/{id}"
        body_dict = {
            'form': form
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )


class RelationLayersResource:
    """
    Resource class for relationLayers operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def shift(self, relation_layer_id: str, direction: str) -> Any:
        """
        Shift a relation layer's order.

        Args:
            relation_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def shift_async(self, relation_layer_id: str, direction: str) -> Any:
        """
        Shift a relation layer's order.

        Args:
            relation_layer_id: Path parameter
            direction: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/shift"
        body_dict = {
            'direction': direction
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def create(self, span_layer_id: str, name: str) -> Any:
        """
        Create a new relation layer.

        Args:
            span_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers"
        body_dict = {
            'span-layer-id': span_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, span_layer_id: str, name: str) -> Any:
        """
        Create a new relation layer.

        Args:
            span_layer_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers"
        body_dict = {
            'span-layer-id': span_layer_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def set_config(self, relation_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            relation_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_config_async(self, relation_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """
        Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.

        Args:
            relation_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
            config_value: Configuration value to set
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}"
        body_data = config_value
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_config(self, relation_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            relation_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_config_async(self, relation_layer_id: str, namespace: str, config_key: str) -> Any:
        """
        Remove a configuration value for a layer.

        Args:
            relation_layer_id: Path parameter
            namespace: Path parameter
            config_key: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def get(self, relation_layer_id: str, as_of: str = None) -> Any:
        """
        Get a relation layer by ID.

        Args:
            relation_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, relation_layer_id: str, as_of: str = None) -> Any:
        """
        Get a relation layer by ID.

        Args:
            relation_layer_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, relation_layer_id: str) -> Any:
        """
        Delete a relation layer.

        Args:
            relation_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, relation_layer_id: str) -> Any:
        """
        Delete a relation layer.

        Args:
            relation_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, relation_layer_id: str, name: str) -> Any:
        """
        Update a relation layer's name.

        Args:
            relation_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, relation_layer_id: str, name: str) -> Any:
        """
        Update a relation layer's name.

        Args:
            relation_layer_id: Path parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        body_dict = {
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )


class TokensResource:
    """
    Resource class for tokens operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, token_layer_id: str, text: str, begin: int, end: int, precedence: int = None, metadata: Any = None) -> Any:
        """
        Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

token_layer_id: the layer in which to insert this token.
text: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text
end: the exclusive character-based offset at which this token ends in the body of the text specified by text
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.

        Args:
            token_layer_id: Required body parameter
            text: Required body parameter
            begin: Required body parameter
            end: Required body parameter
            precedence: Optional body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens"
        body_dict = {
            'token-layer-id': token_layer_id,
            'text': text,
            'begin': begin,
            'end': end,
            'precedence': precedence,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def create_async(self, token_layer_id: str, text: str, begin: int, end: int, precedence: int = None, metadata: Any = None) -> Any:
        """
        Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

token_layer_id: the layer in which to insert this token.
text: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text
end: the exclusive character-based offset at which this token ends in the body of the text specified by text
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.

        Args:
            token_layer_id: Required body parameter
            text: Required body parameter
            begin: Required body parameter
            end: Required body parameter
            precedence: Optional body parameter
            metadata: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens"
        body_dict = {
            'token-layer-id': token_layer_id,
            'text': text,
            'begin': begin,
            'end': end,
            'precedence': precedence,
            'metadata': metadata
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def get(self, token_id: str, as_of: str = None) -> Any:
        """
        Get a token.

        Args:
            token_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.get(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'GET',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    async def get_async(self, token_id: str, as_of: str = None) -> Any:
        """
        Get a token.

        Args:
            token_id: Path parameter
            as_of: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'GET' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'GET'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'GET',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'GET',
                {'original_error': str(e)}
            )

    def delete(self, token_id: str) -> Any:
        """
        Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_async(self, token_id: str) -> Any:
        """
        Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def update(self, token_id: str, begin: int = None, end: int = None, precedence: int = None) -> Any:
        """
        Update a token. Supported keys:

begin: start index of the token
end: end index of the token
precedence: ordering value for the token relative to other tokens with the same begin--lower means earlier

        Args:
            token_id: Path parameter
            begin: Optional body parameter
            end: Optional body parameter
            precedence: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        body_dict = {
            'begin': begin,
            'end': end,
            'precedence': precedence
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.patch(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PATCH',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    async def update_async(self, token_id: str, begin: int = None, end: int = None, precedence: int = None) -> Any:
        """
        Update a token. Supported keys:

begin: start index of the token
end: end index of the token
precedence: ordering value for the token relative to other tokens with the same begin--lower means earlier

        Args:
            token_id: Path parameter
            begin: Optional body parameter
            end: Optional body parameter
            precedence: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        body_dict = {
            'begin': begin,
            'end': end,
            'precedence': precedence
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PATCH' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PATCH'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.patch(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PATCH',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PATCH',
                {'original_error': str(e)}
            )

    def bulk_create(self, body: List[Any]) -> Any:
        """
        Create multiple tokens in a single operation. Provide an array of objects whose keysare:
token_layer_id, the token's layer
text, the ID of the token's text
begin, the character index at which the token begins (inclusive)
end, the character index at which the token ends (exclusive)
precedence, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same begin
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.post(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    async def bulk_create_async(self, body: List[Any]) -> Any:
        """
        Create multiple tokens in a single operation. Provide an array of objects whose keysare:
token_layer_id, the token's layer
text, the ID of the token's text
begin, the character index at which the token begins (inclusive)
end, the character index at which the token ends (exclusive)
precedence, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same begin
metadata, an optional map of metadata

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'POST' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'POST'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'POST',
                {'original_error': str(e)}
            )

    def bulk_delete(self, body: List[Any]) -> Any:
        """
        Delete multiple tokens in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return self.client._transform_response(data)
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def bulk_delete_async(self, body: List[Any]) -> Any:
        """
        Delete multiple tokens in a single operation. Provide an array of IDs.

        Args:
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/bulk"
        body_data = self.client._transform_request(body)
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return self.client._transform_response(data)
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    def set_metadata(self, token_id: str, body: Any) -> Any:
        """
        Replace all metadata for a token. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            token_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.put(url, json=body_data, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'PUT',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    async def set_metadata_async(self, token_id: str, body: Any) -> Any:
        """
        Replace all metadata for a token. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.

        Args:
            token_id: Path parameter
            body: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}/metadata"
        body_data = body
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'PUT' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'PUT'
                ,'body': body_data
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.put(url, json=body_data, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'PUT',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'PUT',
                {'original_error': str(e)}
            )

    def delete_metadata(self, token_id: str) -> Any:
        """
        Remove all metadata from a token.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            response = requests.delete(url, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'DELETE',
                    error_data
                )
            
            # Extract document versions from response headers
            self.client._extract_document_versions(dict(response.headers))
            
            if 'application/json' in response.headers.get('content-type', '').lower():
                data = response.json()
                return data
            return response.text
        
        except requests.exceptions.RequestException as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )

    async def delete_metadata_async(self, token_id: str) -> Any:
        """
        Remove all metadata from a token.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}/metadata"
        
        headers = {'Content-Type': 'application/json'}
        # Add user agent header if set
        if self.client.agent_name:
            headers['X-Agent-Name'] = self.client.agent_name
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        # Add document-version parameter in strict mode for non-GET requests
        if self.client._strict_mode_document_id and 'DELETE' != 'GET':
            doc_id = self.client._strict_mode_document_id
            if doc_id in self.client._document_versions:
                if 'params' not in locals():
                    params = {}
                params['document-version'] = self.client._document_versions[doc_id]
                from urllib.parse import urlencode
                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})
        
        # Check if we're in batch mode
        if self.client._is_batching:
            operation = {
                'path': url.replace(self.client.base_url, ''),
                'method': 'DELETE'
            }
            self.client._batch_operations.append(operation)
            return {'batched': True}  # Return placeholder
        
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.delete(url, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'DELETE',
                            error_data
                        )
                    
                    # Extract document versions from response headers
                    self.client._extract_document_versions(dict(response.headers))
                    
                    content_type = response.headers.get('content-type', '').lower()
                    if 'application/json' in content_type:
                        data = await response.json()
                return data
                    return await response.text
        
        except aiohttp.ClientError as e:
            if hasattr(e, 'status'):
                raise e  # Re-raise our custom error
            # Handle network errors
            raise PlaidAPIError(
                f'Network error: {str(e)} at {url}',
                0,
                url,
                'DELETE',
                {'original_error': str(e)}
            )


class PlaidClient:
    """
    plaid-api-v1 client
    
    Provides both synchronous and asynchronous methods for API access.
    Sync methods: client.projects.create(...)
    Async methods: await client.projects.create_async(...)
    
    Service coordination methods:
        # Discover services
        services = client.messages.discover_services(project_id)
        
        # Register as a service
        service_info = {'serviceId': 'my-service', 'serviceName': 'My Service', 'description': 'What it does'}
        registration = client.messages.serve(project_id, service_info, handle_request)
        
        # Request service work
        result = client.messages.request_service(project_id, 'target-service', request_data)
    
    Batch operations:
        # Synchronous batch
        client.begin_batch()
        client.projects.create(name='Project 1')  # Gets queued
        client.projects.create(name='Project 2')  # Gets queued
        results = client.submit_batch()  # Executes all as one batch request
        
        # Asynchronous batch
        client.begin_batch()
        await client.projects.create_async(name='Project 1')  # Gets queued
        await client.projects.create_async(name='Project 2')  # Gets queued
        results = await client.submit_batch_async()  # Executes all as one batch request
    
    Document version tracking:
        # Enter strict mode for a specific document
        client.enter_strict_mode(document_id)
        
        # All write operations will now include document version checks
        # Operations will fail with 409 error if document has been modified
        
        # Exit strict mode when done
        client.exit_strict_mode()
    
    Example:
        # Authenticate
        client = PlaidClient.login('http://localhost:8085', 'user_id', 'password')
        
        # Create a project
        project = client.projects.create(name='My Project')
        
        # Get all documents
        docs = client.documents.list()
    """
    
    def __init__(self, base_url: str, token: str):
        """
        Initialize the PlaidClient
        
        Args:
            base_url: The base URL for the API
            token: The authentication token
        """
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.agent_name = None  # User agent name for audit logging
        
        # Initialize batch state
        self._is_batching = False
        self._batch_operations = []
        
        # Initialize document version tracking
        self._document_versions = {}  # Map of document-id -> version
        self._strict_mode_document_id = None  # Document ID for strict mode
        
        # Initialize resource objects
        self.vocab_links = VocabLinksResource(self)
        self.vocab_layers = VocabLayersResource(self)
        self.relations = RelationsResource(self)
        self.span_layers = SpanLayersResource(self)
        self.spans = SpansResource(self)
        self.batch = BatchResource(self)
        self.texts = TextsResource(self)
        self.users = UsersResource(self)
        self.token_layers = TokenLayersResource(self)
        self.documents = DocumentsResource(self)
        self.messages = MessagesResource(self)
        self.projects = ProjectsResource(self)
        self.text_layers = TextLayersResource(self)
        self.login = LoginResource(self)
        self.vocab_items = VocabItemsResource(self)
        self.relation_layers = RelationLayersResource(self)
        self.tokens = TokensResource(self)
    
    def _transform_key_to_snake(self, key: str) -> str:
        """Convert kebab-case and namespaced keys to snake_case"""
        import re
        # Remove namespace prefix
        key = re.sub(r'^[^/]+/', '', key)
        # Convert kebab-case to snake_case
        return re.sub(r'-([a-z])', lambda m: '_' + m.group(1), key)
    
    def _transform_key_from_snake(self, key: str) -> str:
        """Convert snake_case back to kebab-case"""
        return key.replace('_', '-')
    
    def _extract_document_versions(self, response_headers: Dict[str, str]) -> None:
        """Extract and update document versions from response headers"""
        doc_versions_header = response_headers.get('X-Document-Versions')
        if doc_versions_header:
            try:
                versions_map = json.loads(doc_versions_header)
                if isinstance(versions_map, dict):
                    self._document_versions.update(versions_map)
            except (json.JSONDecodeError, TypeError) as e:
                # Log malformed header issues
                print(f"Warning: Failed to parse document versions header: {e}")
    
    def _transform_request(self, obj: Any) -> Any:
        """Transform request data from Python conventions to API conventions"""
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_request(item) for item in obj]
        if isinstance(obj, dict):
            transformed = {}
            for k, v in obj.items():
                new_key = self._transform_key_from_snake(k)
                # Preserve metadata contents without transformation
                if k == 'metadata' and isinstance(v, dict):
                    transformed[new_key] = v
                else:
                    transformed[new_key] = self._transform_request(v)
            return transformed
        return obj
    
    def _transform_response(self, obj: Any) -> Any:
        """Transform response data from API conventions to Python conventions"""
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_response(item) for item in obj]
        if isinstance(obj, dict):
            transformed = {}
            for k, v in obj.items():
                new_key = self._transform_key_to_snake(k)
                # Preserve metadata contents without transformation
                if new_key == 'metadata' and isinstance(v, dict):
                    transformed[new_key] = v
                else:
                    transformed[new_key] = self._transform_response(v)
            return transformed
        return obj
    

    
    def begin_batch(self) -> None:
        """
        Begin a batch of operations. All subsequent API calls will be queued instead of executed.
        """
        self._is_batching = True
        self._batch_operations = []
    
    def submit_batch(self) -> List[Any]:
        """
        Submit all queued batch operations as a single batch request (synchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        """
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f"{self.base_url}/api/v1/batch"
            body = []
            
            for op in self._batch_operations:
                operation_data = {
                    'path': op['path'],
                    'method': op['method'].upper()
                }
                if op.get('body'):
                    operation_data['body'] = op['body']
                body.append(operation_data)
            
            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json'
            }
            
            response = requests.post(url, json=body, headers=headers)
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            results = response.json()
            return [self._transform_response(result) for result in results]
        finally:
            self._is_batching = False
            self._batch_operations = []
    
    async def submit_batch_async(self) -> List[Any]:
        """
        Submit all queued batch operations as a single batch request (asynchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        """
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f"{self.base_url}/api/v1/batch"
            body = []
            
            for op in self._batch_operations:
                operation_data = {
                    'path': op['path'],
                    'method': op['method'].upper()
                }
                if op.get('body'):
                    operation_data['body'] = op['body']
                body.append(operation_data)
            
            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json'
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body, headers=headers) as response:
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
                    results = await response.json()
                    return [self._transform_response(result) for result in results]
        finally:
            self._is_batching = False
            self._batch_operations = []
    
    def abort_batch(self) -> None:
        """
        Abort the current batch without executing any operations.
        """
        self._is_batching = False
        self._batch_operations = []
    
    def is_batch_mode(self) -> bool:
        """
        Check if currently in batch mode.
        
        Returns:
            bool: True if batching is active
        """
        return self._is_batching
    
    def enter_strict_mode(self, document_id: str) -> None:
        """
        Enter strict mode for a specific document.
        
        When in strict mode, write operations will automatically include 
        document-version parameters to prevent concurrent modifications. 
        Operations on stale documents will fail with HTTP 409 errors.
        
        Args:
            document_id: The ID of the document to track versions for
        """
        self._strict_mode_document_id = document_id
    
    def exit_strict_mode(self) -> None:
        """
        Exit strict mode and stop tracking document versions for writes.
        """
        self._strict_mode_document_id = None
    
    def set_agent_name(self, agent_name: str) -> None:
        """
        Set the user agent name for audit logging.
        
        When set, the client will include an X-Agent-Name header in all requests
        to identify non-human clients in the audit log.
        
        Args:
            agent_name: Name to identify this client in audit logs
        """
        self.agent_name = agent_name
    
    @classmethod
    def login(cls, base_url: str, user_id: str, password: str) -> 'PlaidClient':
        """
        Authenticate and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        """
        temp_client = cls(base_url, '')
        response = requests.post(
            f"{base_url}/api/v1/login",
            json={'user-id': user_id, 'password': password},
            headers={'Content-Type': 'application/json'}
        )
        
        if not response.ok:
            # Parse error response
            try:
                error_data = response.json()
            except requests.exceptions.JSONDecodeError:
                error_data = {'message': response.text}
            
            server_message = error_data.get('error') or error_data.get('message') or response.reason
            raise PlaidAPIError(
                f'HTTP {response.status_code} {server_message} at {base_url}/api/v1/login',
                response.status_code,
                f'{base_url}/api/v1/login',
                'POST',
                error_data
            )
        
        token = response.json().get('token', '')
        return cls(base_url, token)
    
    @classmethod
    async def login_async(cls, base_url: str, user_id: str, password: str) -> 'PlaidClient':
        """
        Authenticate asynchronously and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        """
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/api/v1/login",
                json={'user-id': user_id, 'password': password},
                headers={'Content-Type': 'application/json'}
            ) as response:
                
                if not response.ok:
                    # Parse error response
                    try:
                        error_data = await response.json()
                    except aiohttp.ContentTypeError:
                        error_data = {'message': await response.text()}
                    
                    server_message = error_data.get('error') or error_data.get('message') or response.reason
                    raise PlaidAPIError(
                        f'HTTP {response.status} {server_message} at {base_url}/api/v1/login',
                        response.status,
                        f'{base_url}/api/v1/login',
                        'POST',
                        error_data
                    )
                
                data = await response.json()
                token = data.get('token', '')
                return cls(base_url, token)
