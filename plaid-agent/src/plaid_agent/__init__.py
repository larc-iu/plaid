"""plaid-agent: bring-your-own-model assistant services for Plaid.

:mod:`plaid_agent.core` is the harness every app's assistant shares: the model
loop, the conversation record, the request lifecycle, the web tools and the
plan mechanics. :mod:`plaid_agent.igt` and :mod:`plaid_agent.ud` are the two
assistants built on it, each a project model, a tool set, a prompt and a
citation renderer.

Nothing is imported here: an app's assistant pulls in litellm and its own
app's modules, and importing one should not drag in the other.
"""
