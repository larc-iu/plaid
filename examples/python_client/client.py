"""
plaid-api-v1 - Plaid's REST API
Version: v1.0
Generated on: Sat Jun 14 13:56:23 EDT 2025
"""

import requests
import aiohttp
from typing import Any, Dict, List, Optional, Union


class RelationsResource:
    """
    Resource class for relations operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def target(self, relation_id: str, span_id: str) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def target_async(self, relation_id: str, span_id: str) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, relation_id: str) -> Any:
        """
        Delete a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, relation_id: str) -> Any:
        """
        Delete a relation.

        Args:
            relation_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relations/{relation_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def source(self, relation_id: str, span_id: str) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def source_async(self, relation_id: str, span_id: str) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def create(self, layer_id: str, source_id: str, target_id: str, value: Any) -> Any:
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
        """
        url = f"{self.client.base_url}/api/v1/relations"
        body_dict = {
            'layer-id': layer_id,
            'source-id': source_id,
            'target-id': target_id,
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, layer_id: str, source_id: str, target_id: str, value: Any) -> Any:
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
        """
        url = f"{self.client.base_url}/api/v1/relations"
        body_dict = {
            'layer-id': layer_id,
            'source-id': source_id,
            'target-id': target_id,
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, span_layer_id: str) -> Any:
        """
        Delete a span layer.

        Args:
            span_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, span_layer_id: str) -> Any:
        """
        Delete a span layer.

        Args:
            span_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/span-layers/{span_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class SpansResource:
    """
    Resource class for spans operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def tokens(self, span_id: str, tokens: List[Any]) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def tokens_async(self, span_id: str, tokens: List[Any]) -> Any:
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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def create(self, span_layer_id: str, tokens: List[Any], value: Any) -> Any:
        """
        Create a new span. A span holds a a value and must at all times be associated with one or more tokens.

span_layer_id: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by span_layer_id.
value: the value of the span, used for annotation.

        Args:
            span_layer_id: Required body parameter
            tokens: Required body parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans"
        body_dict = {
            'span-layer-id': span_layer_id,
            'tokens': tokens,
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, span_layer_id: str, tokens: List[Any], value: Any) -> Any:
        """
        Create a new span. A span holds a a value and must at all times be associated with one or more tokens.

span_layer_id: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by span_layer_id.
value: the value of the span, used for annotation.

        Args:
            span_layer_id: Required body parameter
            tokens: Required body parameter
            value: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/spans"
        body_dict = {
            'span-layer-id': span_layer_id,
            'tokens': tokens,
            'value': value
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, span_id: str) -> Any:
        """
        Delete a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, span_id: str) -> Any:
        """
        Delete a span.

        Args:
            span_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/spans/{span_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class TextsResource:
    """
    Resource class for texts operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, text_layer_id: str, document_id: str, body_text: str) -> Any:
        """
        Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

text_layer_id: the text's associated layer.
document_id: the text's associated document.
body: the string which is the content of this text.

        Args:
            text_layer_id: Required body parameter
            document_id: Required body parameter
            body_text: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts"
        body_dict = {
            'text-layer-id': text_layer_id,
            'document-id': document_id,
            'body': body_text
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, text_layer_id: str, document_id: str, body_text: str) -> Any:
        """
        Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

text_layer_id: the text's associated layer.
document_id: the text's associated document.
body: the string which is the content of this text.

        Args:
            text_layer_id: Required body parameter
            document_id: Required body parameter
            body_text: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts"
        body_dict = {
            'text-layer-id': text_layer_id,
            'document-id': document_id,
            'body': body_text
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, text_id: str) -> Any:
        """
        Delete a text and all dependent data.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, text_id: str) -> Any:
        """
        Delete a text and all dependent data.

        Args:
            text_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def update(self, text_id: str, body_text: str) -> Any:
        """
        Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.

        Args:
            text_id: Path parameter
            body_text: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        body_dict = {
            'body': body_text
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def update_async(self, text_id: str, body_text: str) -> Any:
        """
        Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.

        Args:
            text_id: Path parameter
            body_text: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/texts/{text_id}"
        body_dict = {
            'body': body_text
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def audit(self, user_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a user's actions

        Args:
            user_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{user_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def audit_async(self, user_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a user's actions

        Args:
            user_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{user_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, id: str) -> Any:
        """
        Delete a user

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, id: str) -> Any:
        """
        Delete a user

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/users/{id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def update(self, id: str, password: str = None, username: str = None, is_admin: bool = None) -> Any:
        """
        Modify a user

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def update_async(self, id: str, password: str = None, username: str = None, is_admin: bool = None) -> Any:
        """
        Modify a user

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, token_layer_id: str) -> Any:
        """
        Delete a token layer.

        Args:
            token_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, token_layer_id: str) -> Any:
        """
        Delete a token layer.

        Args:
            token_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/token-layers/{token_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class DocumentsResource:
    """
    Resource class for documents operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def audit(self, document_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a document

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def audit_async(self, document_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a document

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def get(self, document_id: str, as_of: str = None, include_body: bool = None) -> Any:
        """
        Get a document. Set include_body to true in order to include all data contained in the document.

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
            include_body: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if include_body is not None:
            params['include-body'] = include_body
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def get_async(self, document_id: str, as_of: str = None, include_body: bool = None) -> Any:
        """
        Get a document. Set include_body to true in order to include all data contained in the document.

        Args:
            document_id: Path parameter
            as_of: Optional query parameter
            include_body: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if include_body is not None:
            params['include-body'] = include_body
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, document_id: str) -> Any:
        """
        Delete a document and all data contained.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, document_id: str) -> Any:
        """
        Delete a document and all data contained.

        Args:
            document_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/documents/{document_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def create(self, project_id: str, name: str) -> Any:
        """
        Create a new document in a project. Requires project_id and name.

        Args:
            project_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents"
        body_dict = {
            'project-id': project_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, project_id: str, name: str) -> Any:
        """
        Create a new document in a project. Requires project_id and name.

        Args:
            project_id: Required body parameter
            name: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/documents"
        body_dict = {
            'project-id': project_id,
            'name': name
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def add_writer_async(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read and write for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def remove_writer(self, id: str, user_id: str) -> Any:
        """
        Remove a user's writer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def remove_writer_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's writer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/writers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def add_reader(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read-only for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def add_reader_async(self, id: str, user_id: str) -> Any:
        """
        Set a user's access level to read-only for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def remove_reader(self, id: str, user_id: str) -> Any:
        """
        Remove a user's reader privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def remove_reader_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's reader privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/readers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def add_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Assign a user as a maintainer for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def remove_maintainer_async(self, id: str, user_id: str) -> Any:
        """
        Remove a user's maintainer privileges for this project.

        Args:
            id: Path parameter
            user_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}/maintainers/{user_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def audit(self, project_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a project

        Args:
            project_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{project_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def audit_async(self, project_id: str, as_of: str = None, start_time: str = None, end_time: str = None) -> Any:
        """
        Get audit log for a project

        Args:
            project_id: Path parameter
            as_of: Optional query parameter
            start_time: Optional query parameter
            end_time: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{project_id}/audit"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if start_time is not None:
            params['start-time'] = start_time
        if end_time is not None:
            params['end-time'] = end_time
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def get(self, id: str, as_of: str = None, include_documents: bool = None) -> Any:
        """
        Get a project by ID. If include_documents is true, also include document IDs and names.

        Args:
            id: Path parameter
            as_of: Optional query parameter
            include_documents: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if include_documents is not None:
            params['include-documents'] = include_documents
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def get_async(self, id: str, as_of: str = None, include_documents: bool = None) -> Any:
        """
        Get a project by ID. If include_documents is true, also include document IDs and names.

        Args:
            id: Path parameter
            as_of: Optional query parameter
            include_documents: Optional query parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        params = {}
        if as_of is not None:
            params['as-of'] = as_of
        if include_documents is not None:
            params['include-documents'] = include_documents
        if params:
            from urllib.parse import urlencode
            # Convert boolean values to lowercase strings
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}
            url += '?' + urlencode(params)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, id: str) -> Any:
        """
        Delete a project.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, id: str) -> Any:
        """
        Delete a project.

        Args:
            id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/projects/{id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, text_layer_id: str) -> Any:
        """
        Delete a text layer.

        Args:
            text_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, text_layer_id: str) -> Any:
        """
        Delete a text layer.

        Args:
            text_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/text-layers/{text_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class LoginResource:
    """
    Resource class for login operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, username: str, password: str) -> Any:
        """
        Authenticate with a username and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.

        Args:
            username: Required body parameter
            password: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/login"
        body_dict = {
            'username': username,
            'password': password
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, username: str, password: str) -> Any:
        """
        Authenticate with a username and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.

        Args:
            username: Required body parameter
            password: Required body parameter
        """
        url = f"{self.client.base_url}/api/v1/login"
        body_dict = {
            'username': username,
            'password': password
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.put(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.put(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, relation_layer_id: str) -> Any:
        """
        Delete a relation layer.

        Args:
            relation_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, relation_layer_id: str) -> Any:
        """
        Delete a relation layer.

        Args:
            relation_layer_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/relation-layers/{relation_layer_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class TokensResource:
    """
    Resource class for tokens operations
    """
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client

    def create(self, token_layer_id: str, text_id: str, begin: int, end: int, precedence: int = None) -> Any:
        """
        Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

token_layer_id: the layer in which to insert this token.
text_id: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text_id
end: the exclusive character-based offset at which this token ends in the body of the text specified by text_id
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.

        Args:
            token_layer_id: Required body parameter
            text_id: Required body parameter
            begin: Required body parameter
            end: Required body parameter
            precedence: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens"
        body_dict = {
            'token-layer-id': token_layer_id,
            'text-id': text_id,
            'begin': begin,
            'end': end,
            'precedence': precedence
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.post(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def create_async(self, token_layer_id: str, text_id: str, begin: int, end: int, precedence: int = None) -> Any:
        """
        Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

token_layer_id: the layer in which to insert this token.
text_id: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text_id
end: the exclusive character-based offset at which this token ends in the body of the text specified by text_id
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.

        Args:
            token_layer_id: Required body parameter
            text_id: Required body parameter
            begin: Required body parameter
            end: Required body parameter
            precedence: Optional body parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens"
        body_dict = {
            'token-layer-id': token_layer_id,
            'text-id': text_id,
            'begin': begin,
            'end': end,
            'precedence': precedence
        }
        # Filter out None values
        body_dict = {k: v for k, v in body_dict.items() if v is not None}
        body_data = self.client._transform_request(body_dict)
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

    def delete(self, token_id: str) -> Any:
        """
        Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.delete(url, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

    async def delete_async(self, token_id: str) -> Any:
        """
        Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.

        Args:
            token_id: Path parameter
        """
        url = f"{self.client.base_url}/api/v1/tokens/{token_id}"
        
        headers = {'Content-Type': 'application/json'}
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.delete(url, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        response = requests.patch(url, json=body_data, headers=headers)
        response.raise_for_status()
        
        if 'application/json' in response.headers.get('content-type', '').lower():
            data = response.json()
            return self.client._transform_response(data)
        return response.text()

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
        headers['Authorization'] = f'Bearer {self.client.token}'
        
        async with aiohttp.ClientSession() as session:
            async with session.patch(url, json=body_data, headers=headers) as response:
                response.raise_for_status()
                
                content_type = response.headers.get('content-type', '').lower()
                if 'application/json' in content_type:
                    data = await response.json()
                    return self.client._transform_response(data)
                return await response.text()


class PlaidClient:
    """
    plaid-api-v1 client
    
    Provides both synchronous and asynchronous methods for API access.
    Sync methods: client.projects.create(...)
    Async methods: await client.projects.create_async(...)
    
    Example:
        # Authenticate
        client = PlaidClient.login('http://localhost:8085', 'username', 'password')
        
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
        
        # Initialize resource objects
        self.relations = RelationsResource(self)
        self.span_layers = SpanLayersResource(self)
        self.spans = SpansResource(self)
        self.texts = TextsResource(self)
        self.users = UsersResource(self)
        self.token_layers = TokenLayersResource(self)
        self.documents = DocumentsResource(self)
        self.projects = ProjectsResource(self)
        self.text_layers = TextLayersResource(self)
        self.login = LoginResource(self)
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
    
    def _transform_request(self, obj: Any) -> Any:
        """Transform request data from Python conventions to API conventions"""
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_request(item) for item in obj]
        if isinstance(obj, dict):
            return {self._transform_key_from_snake(k): self._transform_request(v) 
                   for k, v in obj.items()}
        return obj
    
    def _transform_response(self, obj: Any) -> Any:
        """Transform response data from API conventions to Python conventions"""
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_response(item) for item in obj]
        if isinstance(obj, dict):
            return {self._transform_key_to_snake(k): self._transform_response(v) 
                   for k, v in obj.items()}
        return obj
    
    @classmethod
    def login(cls, base_url: str, username: str, password: str) -> 'PlaidClient':
        """
        Authenticate and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            username: Username for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        """
        temp_client = cls(base_url, '')
        response = requests.post(
            f"{base_url}/api/v1/login",
            json={'username': username, 'password': password},
            headers={'Content-Type': 'application/json'}
        )
        response.raise_for_status()
        token = response.json().get('token', '')
        return cls(base_url, token)
    
    @classmethod
    async def login_async(cls, base_url: str, username: str, password: str) -> 'PlaidClient':
        """
        Authenticate asynchronously and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            username: Username for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        """
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/api/v1/login",
                json={'username': username, 'password': password},
                headers={'Content-Type': 'application/json'}
            ) as response:
                response.raise_for_status()
                data = await response.json()
                token = data.get('token', '')
                return cls(base_url, token)
