"""Layer constraints: rules an app declares on the token, span and relation
layers it owns, which the server enforces inside every write. A write that
breaks one on a row it writes is refused with 422 and the violations. See the
core manual, "Layer constraints". The JS twin is plaid-client-js's
``constraints.js``."""

from plaid_client.transforms import transform_response

#: The constraint types.
CONSTRAINT_TYPES = (
    'max-in-degree',
    'acyclic',
    'same-ancestor',
    'single-span',
    'value-set',
    'coextensive',
    'single-link',
)


def violations_of(err):
    """The violations of a write refused by a layer constraint, snake_cased
    (``{'constraint', 'namespace', 'layer', 'layer_name', 'document', 'at',
    'ids', 'value'?, 'parts'?}``), or None for any other error. The answer
    lists at most 100, and ``err.response_data['violation-count']`` is the
    total."""
    if getattr(err, 'status', None) != 422:
        return None
    data = getattr(err, 'response_data', None)
    vs = data.get('violations') if isinstance(data, dict) else None
    return transform_response(vs) if isinstance(vs, list) else None
