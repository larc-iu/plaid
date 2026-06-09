"""Service self-description: tasks, summary, and a parameter schema.

Python mirror of the JS client's ``serviceSchema.js``. A service advertises, in
its ``extras`` map, the tasks it serves, a human summary, and a schema of
user-controllable arguments. Apps use this so that, at a fixed integration point
(a "task" like tokenize / parse / transcribe), a user can pick among services,
fill in the service's arguments, and read its summary. See the Plaid manual,
"Describing a service".

Author ``parameters`` with the :class:`Param` builders and assemble the whole
object with :func:`build_extras`; pass the result as a service's ``extras``. Keys
are snake_case here — the client transform converts them to the camelCase a JS UI
sees. A parameter's ``key`` is a string VALUE and travels verbatim, so read each
argument back under the same key you declared.
"""


class TASKS:
    """Controlled task vocabulary — the fixed integration-point goals."""
    TOKENIZE = 'tokenize'
    PARSE = 'parse'
    TRANSCRIBE = 'transcribe'


def _normalize_options(options):
    """Accept options as strings, ``(value, label)`` tuples, or dicts and
    normalize to ``[{'value', 'label'}]``."""
    out = []
    for opt in options or []:
        if isinstance(opt, dict):
            out.append({'value': opt['value'], 'label': opt.get('label', str(opt['value']))})
        elif isinstance(opt, (tuple, list)):
            value, label = opt[0], (opt[1] if len(opt) > 1 else str(opt[0]))
            out.append({'value': value, 'label': label})
        else:
            out.append({'value': opt, 'label': str(opt)})
    return out


class Param:
    """Builders for parameter descriptors. Each returns a plain dict."""

    @staticmethod
    def string(key, label, *, description=None, default='', required=False,
               placeholder=None, multiline=False):
        p = {'key': key, 'label': label, 'type': 'string',
             'default': default, 'required': required}
        if description is not None:
            p['description'] = description
        if placeholder is not None:
            p['placeholder'] = placeholder
        if multiline:
            p['multiline'] = True
        return p

    @staticmethod
    def number(key, label, *, description=None, default=None, required=False,
               min=None, max=None, step=None):
        if default is None:
            default = min if min is not None else 0
        p = {'key': key, 'label': label, 'type': 'number',
             'default': default, 'required': required}
        if description is not None:
            p['description'] = description
        if min is not None:
            p['min'] = min
        if max is not None:
            p['max'] = max
        if step is not None:
            p['step'] = step
        return p

    @staticmethod
    def boolean(key, label, *, description=None, default=False, required=False):
        p = {'key': key, 'label': label, 'type': 'boolean',
             'default': default, 'required': required}
        if description is not None:
            p['description'] = description
        return p

    @staticmethod
    def enum(key, label, options, *, description=None, default=None, required=False):
        opts = _normalize_options(options)
        if default is None and opts:
            default = opts[0]['value']
        p = {'key': key, 'label': label, 'type': 'enum',
             'options': opts, 'default': default, 'required': required}
        if description is not None:
            p['description'] = description
        return p

    @staticmethod
    def multiselect(key, label, options, *, description=None, default=None, required=False):
        opts = _normalize_options(options)
        p = {'key': key, 'label': label, 'type': 'multiselect',
             'options': opts, 'default': list(default) if default else [],
             'required': required}
        if description is not None:
            p['description'] = description
        return p


def build_extras(tasks, summary=None, parameters=None, extra=None):
    """Assemble a standardized self-description ``extras`` dict.

    Args:
        tasks: Iterable of task strings (use :class:`TASKS`).
        summary: Optional rich human description (markdown).
        parameters: Optional list of :class:`Param` descriptors.
        extra: Optional dict of additional, service-specific extras to merge in.
    """
    extras = {'schema_version': 1, 'tasks': list(tasks or [])}
    if summary is not None:
        extras['summary'] = summary
    extras['parameters'] = list(parameters or [])
    if extra:
        extras.update(extra)
    return extras


def _default_for_param(param):
    ptype = param.get('type')
    opts = [o['value'] for o in (param.get('options') or [])]
    # enum/multiselect: validate the declared default against options so an
    # out-of-range default never escapes.
    if ptype == 'enum':
        d = param.get('default')
        if d is not None and d in opts:
            return d
        return opts[0] if opts else ''
    if ptype == 'multiselect':
        d = param.get('default')
        arr = d if isinstance(d, list) else []
        return [x for x in arr if x in opts] if opts else arr
    if param.get('default') is not None:
        return param['default']
    if ptype == 'number':
        return param['min'] if isinstance(param.get('min'), (int, float)) else 0
    if ptype == 'boolean':
        return False
    return ''


def default_values(parameters):
    """Default values keyed by param key — initial form/request state."""
    out = {}
    for param in parameters or []:
        if param.get('key'):
            out[param['key']] = _default_for_param(param)
    return out


def coerce(parameters, raw):
    """Coerce/validate raw values against the schema.

    Returns ``(values, errors)``: ``values`` keyed by param key (ready to merge
    into a request payload), ``errors`` keyed by param key for unmet ``required``.
    Unknown keys in ``raw`` are dropped. Mirrors the JS ``coerceParamValues``.
    """
    values = {}
    errors = {}
    src = raw or {}
    for param in parameters or []:
        key = param.get('key')
        if not key:
            continue
        v = src.get(key, _default_for_param(param))
        ptype = param.get('type')
        if ptype == 'number':
            # Blank / None counts as "missing" → the param's default (matches the
            # JS client, where Number('') is 0 but we likewise route blanks to the
            # default before clamping).
            if v is None or (isinstance(v, str) and v.strip() == ''):
                v = _default_for_param(param)
            else:
                try:
                    v = float(v)
                    if v.is_integer():
                        v = int(v)
                except (TypeError, ValueError):
                    v = _default_for_param(param)
            if isinstance(param.get('min'), (int, float)):
                v = max(param['min'], v)
            if isinstance(param.get('max'), (int, float)):
                v = min(param['max'], v)
        elif ptype == 'boolean':
            v = v is True or v == 'true'
        elif ptype == 'enum':
            opts = [o['value'] for o in (param.get('options') or [])]
            if opts and v not in opts:
                v = _default_for_param(param)
        elif ptype == 'multiselect':
            opts = [o['value'] for o in (param.get('options') or [])]
            arr = v if isinstance(v, list) else ([] if v in (None, '') else [v])
            v = [x for x in arr if x in opts] if opts else arr
        else:
            v = '' if v is None else str(v)

        if param.get('required'):
            empty = v in ('', None) or (isinstance(v, list) and not v)
            if empty:
                errors[key] = f"{param.get('label', key)} is required"
        values[key] = v
    return values, errors
