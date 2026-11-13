import igt_job_hand as H
import igtlib as L

TEXTS = ('Lezgi text 1',)
ASK = ('Lezgi text 1 has я unanalysed seven times, and Lezgi text 4 glosses it two ways: "was" and COP. Which '
       'should the job write? I can also analyse the first sentences here first.')


def _card(ctx, docs=TEXTS, brief='Gloss я as COP everywhere.', every=False, status=None):
    card = {'id': '0190f000-0000-7000-8000-00000000000a', 'all': every, 'brief': brief,
            'summary': '', 'status': status}
    if every:
        card['count'] = len(ctx.project['documents'])
    else:
        card.update(count=len(docs), documents=[{'id': L.doc_of(ctx, n)['id'], 'name': n} for n in docs])
    return card


def _conv(*turns):
    """One display item per user message and per reply: (said, reply text, card or None)."""
    display = []
    for said, text, card in turns:
        display.append({'kind': 'user', 'text': said})
        reply = {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}
        if card is not None:
            reply['job'] = card
        display.append(reply)
    return {'messages': [], 'display': display}


ASKED = 'Set up an overnight job to segment and gloss Lezgi text 1.'
ANSWER = 'Gloss я as COP everywhere. Draft the job.'


def right(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def right_asks_in_the_draft(ctx):
    # Drafted at once with the question in the same reply, then drafted again
    # with the answer: the newest card is judged.
    return _conv((ASKED, ASK + ' The card below leaves я to you.', _card(ctx, brief='Segment and gloss.')),
                 (ANSWER, 'Here is the job again.', _card(ctx)))


def right_started(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, status='started')))


def wrong_never_raised(ctx):
    return _conv((ASKED, 'Here is the job card.', _card(ctx, brief='Segment and gloss every blank word.')),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_named_without_asking(ctx):
    # REV-JB-10: я named in passing, nothing asked, then drafted.
    return _conv((ASKED, 'Lezgi text 1 has 40 blank words, я among them. Say go and I will draft the job.', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def right_tells_without_a_question(ctx):
    # REV-FIX3-8: the choice raised, no "?" put.
    return _conv((ASKED, 'People gloss я two ways in Lezgi text 4, COP and "was". Tell me which the job should '
                         'use.', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_names_it_and_asks_something_else(ctx):
    # REV-FIX3-8: я named, a question put, and not the one that matters.
    return _conv((ASKED, 'Lezgi text 1 has я blank seven times. Shall I draft the job now?', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_asked_about_another_form(ctx):
    return _conv((ASKED, 'Should the job gloss loanwords? I can draft it after.', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_adds_linking(ctx):
    # glm53-stretch-3 reps 2 and 3: the brief carries COP and adds a link task
    # nobody asked for.
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(
        ctx, brief='Gloss я as COP everywhere. Then link every analysed morpheme to its lexicon entry.')))


def wrong_adds_linking_as_a_numbered_step(ctx):
    # glm53-stretch-3 rep 3's shape: a numbered step that adds linking.
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(
        ctx, brief='(1) Segment and gloss every blank word, я as COP. (2) Link every morpheme to its entry.')))


def right_says_not_to_link(ctx):
    # REV-JG3-6: a careful brief rules linking out, and is right.
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(
        ctx, brief='Gloss я as COP everywhere. Do not link anything.')))


def right_leaves_links_alone(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(
        ctx, brief='Gloss я as COP everywhere. Leave lexicon links as they are, and create no entries and no '
                   'links.')))


def wrong_names_one_gloss_only(ctx):
    # glm53-stretch-3 rep 2's first reply: я named with one gloss of its own
    # choosing, not the two people hold, then drafted on the answer.
    return _conv((ASKED, 'Seven я have no analysis. Gloss them "cop", as ава is? Say so and I draft the job.', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_no_card(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'I will gloss я as COP.', None))


def wrong_documents(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, docs=TEXTS + ('Lezgi text 2',))))


def wrong_every_document(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, every=True)))


def wrong_brief_without_the_answer(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, brief='Segment and gloss.')))


def wrong_wrote_a_plan_too(ctx):
    # A gloss written beside the card, as an approved plan writes it.
    name = next(d['name'] for d in ctx.project['documents'] if d['name'] not in TEXTS)
    word = next(a for a, _ in H.words(ctx, name) if L.morphemes_of(L.raw(ctx, name), a))
    L.set_field(ctx, name, {f'{word}.m1': 'COP'})
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx)))
