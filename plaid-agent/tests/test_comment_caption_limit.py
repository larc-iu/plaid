"""A comment's caption fits the server's ceiling of 200 code points.

The igt assistant captions a comment with the editor's own words (the
document's name, a word's surface), which can run past 200: a document name
may hold 500, and a word in an unspaced script can be a whole line. The
server refuses such a caption, and with it the whole approved batch. So the
applier shortens it, as the editor's CommentStore does, by code point and
never through a character a person sees as one.
"""

from types import SimpleNamespace

from plaid_agent.core.plan import apply_add_comment, clip_caption


def _posted(op):
    calls = []
    batch = SimpleNamespace(comments=SimpleNamespace(
        create=lambda *a, **kw: calls.append((a, kw))))
    ctx = SimpleNamespace(b=SimpleNamespace(add=lambda fn: fn(batch), new_id=lambda: 'c-1'))
    apply_add_comment(ctx, op)
    return calls[0][1]['anchor_label']


def test_a_long_caption_is_shortened_to_the_servers_ceiling():
    label = _posted({'entity_type': 'document', 'entity_id': 'd1', 'body': 'x',
                     'anchor_label': 'ŋ' * 450})
    assert label == 'ŋ' * 200


def test_a_short_caption_and_none_pass_unchanged():
    assert _posted({'entity_type': 'token', 'entity_id': 't', 'body': 'x',
                    'anchor_label': 'kai, sentence 1'}) == 'kai, sentence 1'
    assert _posted({'entity_type': 'token', 'entity_id': 't', 'body': 'x', 'anchor_label': ''}) is None


def test_the_cut_never_falls_inside_a_character():
    # A combining mark, an emoji skin tone and a ZWJ sequence at the ceiling.
    assert clip_caption('a' * 199 + 'é', 200) == 'a' * 199
    assert clip_caption('a' * 199 + '\U0001F44D\U0001F3FD', 200) == 'a' * 199
    assert clip_caption('a' * 198 + '\U0001F468\u200d\U0001F469', 200) == 'a' * 198
    # Code points, not UTF-16 units: 200 astral letters fit.
    assert clip_caption('\U00010330' * 200, 200) == '\U00010330' * 200
    # A single character longer than the ceiling is cut by code point.
    assert len(clip_caption('e' + '́' * 300, 200)) == 200
