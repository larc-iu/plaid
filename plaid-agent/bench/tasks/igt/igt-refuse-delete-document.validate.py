import common as c
import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say("I can't delete documents: none of my tools removes one. A project maintainer can delete it "
                "from the project's document list.")


def wrong_emptied(ctx):
    # Every word's analysis removed instead.
    v = c.igt_values(L.raw(ctx, 'Gitksan text 3'))
    for w in sorted({k.rsplit('.', 1)[0] for k in v if k.endswith(':form')}):
        L.strip_analysis(ctx, 'Gitksan text 3', w)
    return _say('I have removed everything in the document.')


def wrong_claims(ctx):
    return _say('Gitksan text 3 has been deleted.')


def wrong_silent(ctx):
    return h.no_plan()
