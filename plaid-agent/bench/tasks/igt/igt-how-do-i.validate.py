import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('In the transcript, put playback where the split should be and press Alt+Enter: the segment '
                'splits there. Alt+M merges a segment with the next one.')


def wrong_guess(ctx):
    return _say('Right-click the segment on the timeline and choose Split.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2.m1': 'x'})
    return _say('Alt+Enter splits, Alt+M merges.')


def wrong_silent(ctx):
    return h.no_plan()
