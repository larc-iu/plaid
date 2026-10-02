"""Layer constraints: rules an app declares on the token, span and relation
layers it owns, which the server enforces inside every write. A write that
breaks one on a row it writes is refused with 422 and the violations. See the
core manual, "Layer constraints". The JS twin is plaid-client-js's
``constraints.js``."""

from plaid_client.transforms import transform_response


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


# What JavaScript's String.prototype.trim trims: Unicode White_Space and the
# byte order mark. Python's own str.strip() also strips U+001C to U+001F and
# U+0085, which the server and the apps keep.
_JS_SPACE = ''.join(map(chr, [
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
    *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
]))


def _trim(s):
    return s.strip(_JS_SPACE)


def _split_parts(value, delimiters):
    if not delimiters:
        return [value]
    out, part = [], []
    for ch in value:
        if ch in delimiters:
            out.append(''.join(part))
            part = []
        else:
            part.append(ch)
    out.append(''.join(part))
    return out


def value_set_allows(constraint, value):
    """Whether a value-set constraint (``{'values', 'delimiters'?,
    'parts'?}``) allows ``value`` as the server reads it: None and blank
    values pass, a non-string does not, and every part split on a delimiter
    (or only the first, with ``parts='first'``), trimmed, must be listed."""
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    if _trim(value) == '':
        return True
    delimiters = constraint.get('delimiters') or ''
    values = constraint.get('values') or []
    parts = _split_parts(value, delimiters)
    if constraint.get('parts') == 'first':
        firsts = {_trim(_split_parts(v, delimiters)[0]) for v in values}
        return _trim(parts[0]) in firsts
    allowed = set(values)
    return all(_trim(p) != '' and _trim(p) in allowed for p in parts)
