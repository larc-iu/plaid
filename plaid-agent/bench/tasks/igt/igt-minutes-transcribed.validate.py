import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('2:20 of the 5:00 recording is transcribed, in 20 segments.')


def wrong_no_length(ctx):
    return _say('2:20 is transcribed, in 20 segments. The recording\'s length is not stored.')


def wrong_estimate(ctx):
    return _say('About 4 minutes, judging from the number of words.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2.m1': 'x'})
    return _say('2:20 of 5:00.')


def wrong_silent(ctx):
    return h.no_plan()
