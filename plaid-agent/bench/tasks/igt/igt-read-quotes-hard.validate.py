import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('Four of the seventeen have « » in the Lezgi line and no quotation marks in the translation: '
                '<cite doc="Lezgi text 1" ref="s1"/>, <cite doc="Lezgi text 1" ref="s3"/>, '
                '<cite doc="Lezgi text 2" ref="s10"/> and <cite doc="Lezgi text 4" ref="s18"/>. '
                'Text 1 sentence 16 is the other way round (quotes in the English only).\n\n'
                'Text 1: 1, 3\nText 2: 10\nText 4: 18')


def wrong_apostrophe(ctx):
    # The "let's" of text 1 s3 read as a quotation mark.
    return _say('Text 1: 1\nText 2: 10\nText 4: 18')


def wrong_reversed(ctx):
    # Quotes in the translation but not in the Lezgi line (s16) counted too.
    return _say('Text 1: 1, 3, 16\nText 2: 10\nText 4: 18')


def wrong_text5(ctx):
    return _say('Text 1: 1, 3\nText 2: 10\nText 4: 18\nText 5: 1')


def wrong_wrote(ctx):
    # The right answer, and one translation "fixed" on the way.
    L.set_field(ctx, 'Lezgi text 4', {'s18': '"It cannot work this way," he says.'}, field='Translation')
    return _say('Text 1: 1, 3\nText 2: 10\nText 4: 18')


def wrong_silent(ctx):
    return h.no_plan()
