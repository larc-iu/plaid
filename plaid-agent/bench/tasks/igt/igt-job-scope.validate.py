import igt_job_hand as H
import igtlib as L

TEXTS = ('Lezgi text 1', 'Lezgi text 2')
ASK = ('Both texts have я unanalysed, and the other texts gloss it two ways: "was" and COP. Which should the '
       'job write? I can also analyse the first sentences here first.')


def _card(ctx, docs=TEXTS, tasks=('gloss',), brief='Gloss я as COP everywhere.', every=False, status=None):
    card = {'id': '0190f000-0000-7000-8000-00000000000a', 'all': every, 'tasks': list(tasks), 'brief': brief,
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


ASKED = 'Set up an overnight job to segment and gloss Lezgi text 1 and Lezgi text 2.'
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


def wrong_asked_about_another_form(ctx):
    return _conv((ASKED, 'Should the job gloss loanwords? I can draft it after.', None),
                 (ANSWER, 'Here is the job, with я as COP.', _card(ctx)))


def wrong_no_card(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'I will gloss я as COP.', None))


def wrong_documents(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, docs=TEXTS[:1])))


def wrong_every_document(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, every=True)))


def wrong_tasks(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, tasks=('gloss', 'link'))))


def wrong_brief_without_the_answer(ctx):
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx, brief='Segment and gloss.')))


def wrong_wrote_a_plan_too(ctx):
    # A gloss written beside the card, as an approved plan writes it.
    name = next(d['name'] for d in ctx.project['documents'] if d['name'] not in TEXTS)
    word = next(a for a, _ in H.words(ctx, name) if L.morphemes_of(L.raw(ctx, name), a))
    L.set_field(ctx, name, {f'{word}.m1': 'COP'})
    return _conv((ASKED, ASK, None), (ANSWER, 'Here is the job.', _card(ctx)))
