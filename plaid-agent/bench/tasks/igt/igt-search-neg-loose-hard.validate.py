import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    # The words that DO have both halves, named on lines of their own before
    # the answer, are reasoning, not a claim (a right answer an older reject
    # pattern refused).
    return _say('Five words have tr- (NEG) without -u: trnzsiklukang <cite doc="Natugu text 4" ref="s3.w13"/>, '
                'three in s18 of text 4 (trkrlz-kakr, trycmne-kakr, trvzne-kakr), and tryrnibutx-zlwzkr.\n'
                'Checked and complete:\n- Text 1: s16.w6, s19.w5 (both end in -u)\n- Text 1: s16.W6 again\n'
                '- Text 3: none\n\n'
                '**Text 4:** 3, 18\n**Text 5:** 8')


def wrong_missing_text5(ctx):
    return _say('Text 4: 3, 18')


def wrong_with_u(ctx):
    # Every tr NEG word listed, the complete circumfixes included.
    return _say('Text 1: 16, 19\nText 2: 10, 11\nText 4: 2, 3, 4, 14, 18\nText 5: 1, 6, 8')


def wrong_extra_sentence(ctx):
    return _say('Text 4: 3, 14, 18\nText 5: 8')


def wrong_sentence_spelled(ctx):
    # Each a closing line claiming a text with no such word, spelled as a
    # sentence ref, with a note, or with the word.
    return _say('Text 1: s16\nText 2: sentence 10\n**Text 3:** s7\nText 4: 3, 18\nText 5: 8')


# Shapes an older reject pattern let pass, one closing line each, claiming
# a text with no such word.
def _claim(line):
    return _say(line + '\nText 4: 3, 18\nText 5: 8')


def wrong_capital_sentence(ctx):
    return _claim('Text 1: Sentence 16')


def wrong_capital_s(ctx):
    return _claim('Text 2: S10')


def wrong_parenthesised(ctx):
    return _claim('Text 1: (s16)')


def wrong_hash(ctx):
    return _claim('Text 1: #16')


def wrong_dash(ctx):
    return _claim('Text 1 \u2014 s16')


def wrong_spaced(ctx):
    return _claim('Text 1: s 16')


def wrong_noted(ctx):
    return _say('Text 1: 16 (one word)\nText 4: 3, 18\nText 5: 8')


def wrong_wrote(ctx):
    # Right answer, and the missing -u "fixed" by a gloss change nobody asked for.
    L.set_field(ctx, 'Natugu text 4', {'s3.w15.m1': 'NEG.INCOMPL'})
    return _say('Text 4: 3, 18\nText 5: 8')


def wrong_silent(ctx):
    return h.no_plan()
