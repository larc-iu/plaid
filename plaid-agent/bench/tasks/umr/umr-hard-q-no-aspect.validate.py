import umr_hand as u


def right(ctx):
    return u.answer('Two events have no :aspect: the shooting aya in s9 (rayanpu, s9a3) and the '
                    'getting out ichima in s10 (s10i2).')


def wrong_half(ctx):
    return u.answer('Only ichima "get out" in sentence 10 has no aspect.')


def wrong_none(ctx):
    return u.answer('Every event in the story already has an aspect.')


def wrong_wrote(ctx):
    u.set_attr(ctx, 9, 's9a3', ':aspect', 'performance')
    u.set_attr(ctx, 10, 's10i2', ':aspect', 'performance')
    return u.answer('aya (s9a3) and ichima (s10i2) had none. I gave them performance.')


# Every node with no aspect, nouns included.
DUMP = 'Here\'s what I found. Every root node in the story already has `:aspect`, but there are a number of **non-root nodes** without it. Since I can\'t be certain which are events versus nouns or modifiers in Kukama, I\'ll list them all by sentence and let you judge.\n\n**Recurring concepts (appear without aspect in multiple sentences):**\n\n| Concept | Sentences |\n|---|---|\n| `arawata` | s6, s7, s8, s10, s11 |\n| `ɨwɨrati` | s1, s3, s4, s8, s15, s19 |\n| `awa` | s1, s14, s17 |\n| `ay` | s14, s15, s16, s17, s18, s19 |\n| `ɨtsɨ` | s14, s16, s18 |\n| `raepe` | s6, s7 |\n\n**Unique to one sentence:**\n\n| Sentence | Node | Concept |\n|---|---|---|\n| s1 | <cite doc="Kukama text 2" ref="s1.s1i3"/> | `ikun` |\n| s1 | <cite doc="Kukama text 2" ref="s1.s1s"/> | `shirinkero` |\n| s2 | <cite doc="Kukama text 2" ref="s2.s2s"/> | `shiringuero` |\n| s2 | <cite doc="Kukama text 2" ref="s2.s2s2"/> | `shiringa` |\n| s2 | <cite doc="Kukama text 2" ref="s2.s2t"/> | `tsuparan` |\n| s3 | <cite doc="Kukama text 2" ref="s3.s3s"/> | `shiringuero` |\n| s9 | <cite doc="Kukama text 2" ref="s9.s9h"/> | `have-location-91` |\n| s9 | <cite doc="Kukama text 2" ref="s9.s9a3"/> | `aya` |\n| s10 | <cite doc="Kukama text 2" ref="s10.s10i2"/> | `ichima` |\n| s17 | <cite doc="Kukama text 2" ref="s17.s17u"/> | `umr-unknown` |\n\nA couple of notes:\n- `aya` already **has** `:aspect` in s8, s11, but the instance in **s9** (<cite doc="Kukama text 2" ref="s9.s9a3"/>) doesn\'t — so that one looks like it was missed.\n- `have-location-91` in s9 has no aspect, whereas the other `-91` rolesets (`have-mod-91`, `exist-91`, `identity-91`) all do — that may also be an oversight.\n- `ay` appears without aspect in six sentences; if it\'s a discourse particle rather than an event, it may not need one.\n\nThat\'s 34 nodes in total without `:aspect`. I\'ve left them all untouched for you.'


def wrong_dump(ctx):
    return u.answer(DUMP)
