import umr_hand as u


def right(ctx):
    return u.answer('s9a2 is aligned to word 3, rchikari. The unaligned nodes are s9p (person), '
                    's9h (have-location-91) and s9t (thing).')


def wrong_missing_one(ctx):
    return u.answer('s9a2 is aligned to rchikari. The unaligned nodes are s9p and s9h.')


def wrong_word(ctx):
    return u.answer('s9a2 is aligned to ariwa. The unaligned nodes are s9p, s9h and s9t.')


def wrong_wrote(ctx):
    u.set_attr(ctx, 9, 's9a2', ':aspect', 'state')
    return u.answer('s9a2 is aligned to word 3, rchikari. The unaligned nodes are s9p, s9h and s9t.')


def _cited(text, vars_):
    conv = u.answer(text)
    conv['display'][-1]['citations'] = [
        {'key': f'<cite doc="Kukama text 2" ref="s9.{v}"/>', 'document_name': 'Kukama text 2', 'number': 9,
         'sentence': 9, 'focus': [v]} for v in vars_]
    return conv


def right_cited(ctx):
    # glm53-1's reply: the unaligned nodes named only in cites, which the
    # panel shows as "Kukama text 2, sentence 9, node s9h"
    return _cited('**1.** s9a2 (after) is aligned to word 3, **rchikari**.\n\n**2.** Three nodes:\n'
                  + ''.join(f'- <cite doc="Kukama text 2" ref="s9.{v}"/> {c}\n'
                            for v, c in (('s9h', 'have-location-91'), ('s9p', 'person'), ('s9t', 'thing'))),
                  ('s9h', 's9p', 's9t'))


def wrong_cited_missing_one(ctx):
    return _cited('s9a2 is aligned to word 3, rchikari. Unaligned: <cite doc="Kukama text 2" ref="s9.s9h"/>, '
                  '<cite doc="Kukama text 2" ref="s9.s9p"/>.', ('s9h', 's9p'))
