"""The app-agnostic half of an assistant service.

Nothing in here knows what an app annotates. An app supplies a project model,
a workspace with tools, a prompt, citations and a plan executor, and
:class:`plaid_agent.core.service.BaseAssistantService` does the rest.
"""
