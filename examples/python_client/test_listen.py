#!/usr/bin/env python3
"""
SSE Listen Test Script

Tests the Python client's SSE event streaming, heartbeat protocol,
and message sending.

Usage:
    python test_listen.py

Requires the plaid-client package to be installed:
    pip install -e ../../plaid-client-py
"""

import getpass
import json
import threading
import time
from datetime import datetime

from plaid_client import PlaidClient

BASE_URL = 'http://localhost:8085'
LISTEN_SECONDS = 30


def handle_event(event_type, data):
    """Handle incoming SSE events."""
    ts = datetime.now().strftime('%H:%M:%S')

    if event_type == 'message':
        user = data.get('user', 'unknown')
        msg_data = data.get('data', {})
        print(f"[{ts}] MESSAGE from {user}: {json.dumps(msg_data, indent=2)}")

    elif event_type == 'audit-log':
        user = data.get('user', 'unknown')
        ops = data.get('ops', [])
        descriptions = [op.get('description', '') for op in ops[:3]]
        print(f"[{ts}] AUDIT from {user}: {'; '.join(descriptions)}")

    else:
        print(f"[{ts}] {event_type}: {json.dumps(data)[:200]}")


def send_test_messages(client, project_id):
    """Send test messages and trigger audit events in a background thread."""
    time.sleep(3)  # let listener start

    messages = [
        {'type': 'test', 'text': 'Hello from Python test!'},
        {'type': 'chat', 'text': 'Chat message from Python', 'channel': 'testing'},
        {'type': 'progress', 'current': 50, 'total': 100, 'status': 'Processing...'},
        {'type': 'progress', 'current': 100, 'total': 100, 'status': 'Complete!'},
    ]

    for i, msg in enumerate(messages):
        try:
            print(f"  >> Sending message {i+1}/{len(messages)}: {msg['type']}")
            client.messages.send_message(project_id, msg)
            time.sleep(1)
        except Exception as e:
            print(f"  >> Failed to send message: {e}")

    # Trigger an audit event by creating a document
    time.sleep(2)
    try:
        doc_name = f'Test Doc {datetime.now().strftime("%H:%M:%S")}'
        print(f"  >> Creating document: {doc_name}")
        doc = client.documents.create(project_id, doc_name)
        print(f"  >> Document created: {doc.get('id', 'unknown')}")
    except Exception as e:
        print(f"  >> Failed to create document: {e}")


def main():
    print("=" * 50)
    print("SSE Listen Test")
    print("=" * 50)

    username = input("Username: ")
    password = getpass.getpass("Password: ")

    client = PlaidClient.login(BASE_URL, username, password)
    print("Authenticated.")

    projects = client.projects.list()
    if not projects:
        print("No projects found. Creating one...")
        project = client.projects.create('SSE Test Project')
        project_id = project['id']
    else:
        project_id = projects[0]['id']
    print(f"Using project: {project_id}")

    # Start sending messages in background
    sender = threading.Thread(target=send_test_messages, args=(client, project_id), daemon=True)
    sender.start()

    # Listen for events (blocks)
    print(f"Listening for {LISTEN_SECONDS}s...")
    conn = client.messages.listen(project_id, handle_event)

    try:
        time.sleep(LISTEN_SECONDS)
    except KeyboardInterrupt:
        print("\nInterrupted.")
    finally:
        conn.close()
        stats = conn.get_stats()
        print()
        print("=" * 50)
        print("Session Stats:")
        print(f"  Duration: {stats['duration_seconds']:.1f}s")
        print(f"  Client ID: {stats['client_id']}")
        print(f"  Events: {stats['events']}")
        print("=" * 50)


if __name__ == "__main__":
    main()
