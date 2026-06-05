import re


def key_to_snake(key):
    """Convert kebab-case/namespaced key to snake_case.
    'layer-id' -> 'layer_id'
    'layer-2' -> 'layer_2' (every hyphen becomes an underscore)
    'relation/layer' -> 'layer' (namespace stripped)

    The JS client uses camelCase, where the analogous key is 'layer2' -- the
    local spelling differs by convention, but neither leaves a stray separator.
    """
    key = re.sub(r'^[^/]+/', '', key)
    return key.replace('-', '_')


def key_from_snake(key):
    """Convert snake_case key to kebab-case.
    'layer_id' -> 'layer-id'
    """
    return key.replace('_', '-')


# ``metadata`` and ``config`` are opaque, client-agnostic buckets: their
# contents are arbitrary user/application data whose keys must NOT vary by
# client. We pass their values through verbatim (no recursion) so object keys
# inside them are never re-cased or namespace-stripped — a label like
# ``case-marker`` used as a map key survives intact. Everything else is API
# envelope and gets the usual case conversion.
OPAQUE_KEYS = ('metadata', 'config', 'bindings')


def transform_request(obj):
    """Recursively transform request object keys from snake_case to kebab-case.
    Preserves ``metadata`` and ``config`` contents without transformation.
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
        if key in OPAQUE_KEYS and isinstance(value, dict):
            transformed[new_key] = value
        else:
            transformed[new_key] = transform_request(value)
    return transformed


def transform_response(obj):
    """Recursively transform response object keys from kebab-case/namespaced to snake_case.
    Preserves ``metadata`` and ``config`` contents without transformation.
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
        if new_key in OPAQUE_KEYS and isinstance(value, dict):
            transformed[new_key] = value
        else:
            transformed[new_key] = transform_response(value)
    return transformed
