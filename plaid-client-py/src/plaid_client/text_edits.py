"""Text edit operations: composing a stream of ops into the net change.

The Python peer of plaid-client-js's ``textEdits.js``. Keep the two in lockstep.

An op is one of the shapes ``PATCH /texts/:id`` takes::

    {'type': 'insert',  'index': i, 'value': str}
    {'type': 'delete',  'index': i, 'value': count}
    {'type': 'replace', 'index': i, 'length': n, 'value': str}

Indices and counts are Unicode code points (a Python ``str`` index), and the
ops are in running coordinates: each op's ``index`` is in the body as the ops
before it left it.

A gap is ``{'start', 'end', 'value'}`` in the OLD body's coordinates: old
``[start, end)`` gives way to ``value``. ``compose_text_edits`` turns any op
stream into gaps that depend only on the net change, never on how the
keystrokes came, which is also how the server reads an edit.
"""

import json
import unicodedata


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _check_op(op, length):
    """The op's type after checking its shape and bounds against a body of
    ``length`` code points, as the server checks it. Raises ValueError."""
    op_type = op.get('type') if isinstance(op, dict) else None
    get = op.get if isinstance(op, dict) else (lambda _k: None)
    index, value, size = get('index'), get('value'), get('length')
    well_formed = (
        (op_type == 'insert' and _is_int(index) and isinstance(value, str))
        or (op_type == 'delete' and _is_int(index) and _is_int(value))
        or (op_type == 'replace' and _is_int(index) and _is_int(size)
            and isinstance(value, str))
    )
    if not well_formed:
        raise ValueError(
            f'Malformed text edit operation: {json.dumps(op, ensure_ascii=False)}. '
            'Expected {type: "insert", index: int, value: string}, '
            '{type: "delete", index: int, value: int} or '
            '{type: "replace", index: int, length: int, value: string}')
    if op_type == 'insert':
        in_bounds = 0 <= index <= length
    elif op_type == 'delete':
        in_bounds = index >= 0 and value >= 0 and index + value <= length
    else:
        in_bounds = index >= 0 and size >= 0 and index + size <= length
    if not in_bounds:
        raise ValueError(
            f'Text edit operation out of bounds: {json.dumps(op, ensure_ascii=False)} '
            f'(text length is {length} code points)')
    return op_type


def _op_parts(op_type, op):
    """How many code points an op removes, and what it types."""
    if op_type == 'insert':
        return 0, op['value']
    if op_type == 'delete':
        return op['value'], ''
    return op['length'], op['value']


# A segment of the new text is ('old', start, end) or ('typed', chars).

def _seg_len(seg):
    return seg[2] - seg[1] if seg[0] == 'old' else len(seg[1])


def _cut_at(segs, at):
    """Cut the segment list so a boundary falls at code point ``at``, and
    return the index of the first segment at or after it."""
    pos = 0
    for i, seg in enumerate(segs):
        n = _seg_len(seg)
        if at == pos:
            return i
        if at < pos + n:
            k = at - pos
            if seg[0] == 'old':
                left, right = ('old', seg[1], seg[1] + k), ('old', seg[1] + k, seg[2])
            else:
                left, right = ('typed', seg[1][:k]), ('typed', seg[1][k:])
            segs[i:i + 1] = [left, right]
            return i + 1
        pos += n
    return len(segs)


def _merge(segs):
    """Neighbouring typed segments as one, and neighbouring old ranges as one."""
    out = []
    for seg in segs:
        last = out[-1] if out else None
        if last and last[0] == 'typed' and seg[0] == 'typed':
            out[-1] = ('typed', last[1] + seg[1])
        elif last and last[0] == 'old' and seg[0] == 'old' and last[2] == seg[1]:
            out[-1] = ('old', last[1], seg[2])
        elif _seg_len(seg) > 0:
            out.append(seg)
    return out


def compose_text_edits(body, ops):
    """The net change of ``ops`` applied in turn to ``body``, as gaps in the
    old body's code points: sorted, and never touching (at least one old code
    point is kept between two gaps). Old text deleted and typed back is typed
    text, and a gap whose value is the old text it removes is dropped. Raises
    ValueError on a malformed or out-of-bounds op."""
    segs = [('old', 0, len(body))] if body else []
    length = len(body)
    for op in ops:
        op_type = _check_op(op, length)
        delete, typed = _op_parts(op_type, op)
        start = _cut_at(segs, op['index'])
        stop = _cut_at(segs, op['index'] + delete)
        segs[start:stop] = [('typed', typed)] if typed else []
        length += len(typed) - delete
        segs = _merge(segs)

    gaps = []
    kept = 0
    typed = []

    def close(nxt):
        if nxt > kept or typed:
            value = ''.join(typed)
            if value != body[kept:nxt]:
                gaps.append({'start': kept, 'end': nxt, 'value': value})
        typed.clear()

    for seg in segs:
        if seg[0] == 'old':
            close(seg[1])
            kept = seg[2]
        else:
            typed.append(seg[1])
    close(len(body))
    return gaps


def gaps_to_ops(gaps):
    """Gaps (old-body coordinates, sorted, not overlapping) as running ops: an
    insert where a gap removes nothing, a delete where it types nothing, and a
    replace otherwise."""
    ops = []
    shift = 0
    for gap in gaps:
        start, end, value = gap['start'], gap['end'], gap['value']
        index = start + shift
        if start == end:
            if value:
                ops.append({'type': 'insert', 'index': index, 'value': value})
        elif not value:
            ops.append({'type': 'delete', 'index': index, 'value': end - start})
        else:
            ops.append({'type': 'replace', 'index': index, 'length': end - start,
                        'value': value})
        shift += len(value) - (end - start)
    return ops


def apply_text_ops(body, ops):
    """``body`` with ``ops`` applied in turn (running coordinates, code
    points). Raises ValueError on a malformed or out-of-bounds op."""
    for op in ops:
        op_type = _check_op(op, len(body))
        delete, typed = _op_parts(op_type, op)
        index = op['index']
        body = body[:index] + typed + body[index + delete:]
    return body


def _nfc(s):
    return unicodedata.normalize('NFC', s)


def compose_text(s):
    """``s`` composed (Unicode NFC), as the server stores every text, and where
    each code-point position of ``s`` goes in it: ``(text, at)``, ``at(p)`` for
    every p in [0, len(s)]. Mirror of the server's
    ``plaid.util.canonical/compose``, for a script that measures tokens on a
    body it is about to send: the server stores ``text``, and a token measured
    at [b, e) on ``s`` is at [at(b), at(e)).

    ``s`` is cut before each code point that is not a mark, a piece joined to
    the one before when the two compose together (Hangul jamo, a vowel sign),
    and each piece composes on its own. A position inside a piece composing
    changed goes to that piece's composed end, so an edge between a letter and
    the mark that composes with it moves to after the composed character.
    ``at`` never reverses two positions.
    """
    s = s or ''
    if unicodedata.is_normalized('NFC', s):
        return s, (lambda p: p)
    n = len(s)
    pieces = []
    start = 0
    for i in range(1, n + 1):
        if i < n and unicodedata.category(s[i]).startswith('M'):
            continue
        if pieces and ord(s[start]) >= 0x300:
            last = pieces[-1]
            a, b = s[last[0]:last[1]], s[start:i]
            if _nfc(a + b) != _nfc(a) + _nfc(b):
                last[1] = i
                start = i
                continue
        pieces.append([start, i])
        start = i
    at = [0] * (n + 1)
    out = []
    pos = 0
    for b, e in pieces:
        src = s[b:e]
        c = _nfc(src)
        out.append(c)
        if c == src:
            for i in range(b, e):
                at[i] = pos + (i - b)
        else:
            at[b] = pos
            for i in range(b + 1, e):
                at[i] = pos + len(c)
        pos += len(c)
    at[n] = pos
    text = ''.join(out)
    if text != _nfc(s):
        raise ValueError('The text could not be composed.')
    return text, (lambda p: at[p])
