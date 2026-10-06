"""A research dataset extractor for the study of how people respond to what
the assistants and other machine writers put in a Plaid project.

It reads a Plaid SQLite database READ-ONLY (a file, never a live server) and
writes a pseudonymized dataset: every assistant plan and what became of it,
every machine write and what people did to it afterwards, the assistants'
tool use per turn, and the client telemetry. ``DATASET.md`` beside this file
describes every field and is copied into each dataset.

Run it as ``python -m plaid_agent.research.extract --help``.
"""
