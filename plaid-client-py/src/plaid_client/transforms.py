import re


def key_to_snake(key):
    """Convert kebab-case/namespaced key to snake_case.
    'layer-id' -> 'layer_id'
    'relation/layer' -> 'layer' (namespace stripped)
    """
    key = re.sub(r'^[^/]+/', '', key)
    return key.replace('-', '_')


def key_from_snake(key):
    """Convert snake_case key to kebab-case.
    'layer_id' -> 'layer-id'
    """
    return key.replace('_', '-')


def transform_request(obj):
    """Recursively transform request object keys from snake_case to kebab-case.
    Preserves metadata contents without transformation.
    """
    if obj is None:
        return obj
    if isinstance(obj, list):
        return [transform_request(item) for item in obj]
    if not isinstance(obj, dict):
        return obj

    transformed = {}
    for key, value in obj.items():
        new_key = key_from_snake(key)
        if key == 'metadata' and isinstance(value, dict):
            transformed[new_key] = value
        else:
            transformed[new_key] = transform_request(value)
    return transformed


def transform_response(obj):
    """Recursively transform response object keys from kebab-case/namespaced to snake_case.
    Preserves metadata contents without transformation.
    """
    if obj is None:
        return obj
    if isinstance(obj, list):
        return [transform_response(item) for item in obj]
    if not isinstance(obj, dict):
        return obj

    transformed = {}
    for key, value in obj.items():
        new_key = key_to_snake(key)
        if new_key == 'metadata' and isinstance(value, dict):
            transformed[new_key] = value
        else:
            transformed[new_key] = transform_response(value)
    return transformed
