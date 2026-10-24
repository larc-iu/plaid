"""Shared by the ud answer tasks' validate files: a conversation whose last
reply is `text`, with or without an applied plan."""


def reply(text, applied=False):
    item = {'kind': 'assistant', 'text': text, 'status': 'applied' if applied else None,
            'plan': {'id': 'validation', 'proposed': [['validation']]} if applied else None}
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'}, item]}
