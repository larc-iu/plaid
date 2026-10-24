import handwrite as h


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say("The commonest pair is 'nii win, 12 times, then ii 'nii (10).")


def wrong_second(ctx):
    return _say("The commonest pair is ii 'nii, 10 times.")


def wrong_open_text_only(ctx):
    return _say("In Gitksan text 1 the commonest pair is 'nii win, 3 times.")


def wrong_silent(ctx):
    return h.no_plan()
