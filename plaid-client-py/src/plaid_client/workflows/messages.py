"""Words a service built on these workflows says to the person who asked.

A request refused because the project is missing a piece of its setup says the
same two sentences in every app and every service, whichever piece it is. What
exactly is missing names layers and ids, which mean nothing on the requester's
screen, so it goes to the operator's log instead.
"""

import logging

log = logging.getLogger(__name__)

#: The one line for a project whose setup is not finished.
SETUP_INCOMPLETE = 'This project is not fully set up. A project maintainer can finish setup.'


def setup_incomplete(detail: str) -> ValueError:
    """The refusal to raise for a missing piece of setup, with ``detail``
    logged for the operator. A ``ValueError``, so it reaches the requester as
    it stands (see ``plaid_client.services.service_error_message``)."""
    log.warning('Project setup incomplete: %s', detail)
    return ValueError(SETUP_INCOMPLETE)
