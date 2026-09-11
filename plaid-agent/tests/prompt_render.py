"""Rendering a tool table for a reader, shared by every app's sample prompt."""


def typ(s: dict) -> str:
    t = s.get('type')
    if 'enum' in s:
        return 'one of ' + ', '.join(f'`{v}`' for v in s['enum'])
    if t == 'array':
        return 'array of ' + typ(s.get('items') or {})
    if t == 'object':
        if s.get('properties'):
            req = set(s.get('required') or [])
            inner = ', '.join(f'{k}: {typ(v)}' + (' (required)' if k in req else '')
                              for k, v in s['properties'].items())
            return 'object {' + inner + '}'
        if 'additionalProperties' in s:
            return 'object of ' + typ(s['additionalProperties'])
    return t or 'any'


def render_tool(spec: dict, web_tools=()) -> str:
    f = spec['function']
    lines = [f"### {f['name']}", '', f['description'], '']
    if f['name'] in web_tools:
        lines += ['*Offered only when the operator started the service with `--web-search`.*', '']
    props = f['parameters'].get('properties') or {}
    req = set(f['parameters'].get('required') or [])
    if not props:
        lines.append('No parameters.')
    else:
        for name, s in props.items():
            kind = typ(s) + (', required' if name in req else '')
            desc = s.get('description')
            lines.append(f'- `{name}` ({kind})' + (f': {desc}' if desc else ''))
    return '\n'.join(lines) + '\n'


