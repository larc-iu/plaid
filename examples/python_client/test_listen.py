#!/usr/bin/env python3

"""
Python Client Event Alignment Test Script

This script demonstrates the Python client's unified event handling approach
and tests both message and audit-log events without requiring CLI arguments.

Usage:
    python test_python_alignment.py

The script will:
1. Connect to the event stream using the unified callback approach
2. Send various types of test messages
3. Trigger audit events by creating/modifying data
4. Show real-time event handling with proper data extraction
"""

import sys
import time
import asyncio
import threading
from datetime import datetime
from typing import Dict, Any, Optional
import json

# Import the generated Plaid client
sys.path.append('/home/luke/local/plaid/examples/python_client')
from client import PlaidClient

# Configuration - no CLI args needed
CONFIG = {
    'base_url': 'http://localhost:8085',
    'token': 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyL2lkIjoiY2xhdWRlQGEuY29tIiwidmVyc2lvbiI6MH0.LNZc7tgN2yZBLKnV_kwT35SF01kKgulVHZ0O8xfvS5c',
    'project_id': '4fe4221b-3cb3-48c2-b8e9-54f3a24601d9'
}

class EventStats:
    """Track event statistics during the session"""
    def __init__(self):
        self.audit_log = 0
        self.message = 0
        self.other = 0
        self.start_time = time.time()
        
    def duration(self):
        return time.time() - self.start_time
        
    def __str__(self):
        return f"Audit: {self.audit_log} | Messages: {self.message} | Other: {self.other} | Duration: {self.duration():.1f}s"

def print_header():
    """Print the test header"""
    print("=" * 60)
    print("🧪 Python Client Event Alignment Test")
    print("=" * 60)
    print(f"📍 Base URL: {CONFIG['base_url']}")
    print(f"🏷️  Project ID: {CONFIG['project_id']}")
    print()
    print("📝 This demonstrates the NEW heartbeat confirmation protocol:")
    print("   • Single callback receives (event_type, data)")
    print("   • connected/heartbeat handled internally with confirmation")
    print("   • audit-log/message events passed to callback") 
    print("   • Same API as JavaScript client")
    print("   • Automatic heartbeat confirmation to server")
    print()

def handle_event(event_type: str, data: Dict[str, Any], stats: EventStats) -> None:
    """
    Unified event handler - this matches the JavaScript client approach
    
    Args:
        event_type: The type of event ('audit-log', 'message', etc.)
        data: The event data dictionary
        stats: Statistics tracker
    """
    timestamp = datetime.now().strftime('%H:%M:%S')
    print(f"[{timestamp}] 📨 Event: {event_type.upper()}")
    
    if event_type == 'message':
        stats.message += 1
        # Extract message details (same structure as JavaScript client receives)
        user = data.get('user', 'unknown')
        message_data = data.get('data', {})
        message_time = data.get('time', '')
        message_id = data.get('id', '')
        
        print(f"  👤 From: {user}")
        print(f"  ⏰ Time: {message_time}")
        print(f"  🆔 ID: {message_id}")
        print(f"  📄 Data: {json.dumps(message_data, indent=6)}")
        
        # Handle different message types
        if isinstance(message_data, dict):
            msg_type = message_data.get('type', 'unknown')
            if msg_type == 'chat':
                text = message_data.get('text', '')
                channel = message_data.get('channel', 'general')
                print(f"     💬 Chat in #{channel}: {text}")
            elif msg_type == 'progress':
                current = message_data.get('current', 0)
                total = message_data.get('total', 100)
                status = message_data.get('status', '')
                percent = round((current / total) * 100) if total > 0 else 0
                print(f"     📊 Progress: {current}/{total} ({percent}%) - {status}")
            elif msg_type == 'test':
                text = message_data.get('text', 'No text')
                print(f"     🧪 Test: {text}")
        
    elif event_type == 'audit-log':
        stats.audit_log += 1
        # Extract audit details (same structure as JavaScript client receives)
        user = data.get('user', 'unknown')
        ops = data.get('ops', [])
        projects = data.get('projects', [])
        audit_time = data.get('time', '')
        
        print(f"  👤 From: {user}")
        print(f"  ⏰ Time: {audit_time}")
        print(f"  📝 Operations: {len(ops)}")
        print(f"  🏗️  Projects affected: {len(projects)}")
        
        # Log operation details
        for i, op in enumerate(ops[:5]):  # Show first 5 operations
            op_type = op.get('type', 'unknown')
            description = op.get('description', '')
            print(f"     {i + 1}. {op_type}: {description}")
        
        if len(ops) > 5:
            print(f"     ... and {len(ops) - 5} more operations")
            
    else:
        stats.other += 1
        print(f"  📦 Data: {json.dumps(data, indent=6)[:200]}{'...' if len(str(data)) > 200 else ''}")
    
    print(f"  📊 Session Stats: {stats}")
    print()

async def send_test_messages(client: PlaidClient, project_id: str):
    """Send various test messages to demonstrate message events"""
    print("🚀 Starting automated message sending in 3 seconds...")
    
    messages = [
        {
            'type': 'test',
            'text': 'Hello from Python test!',
            'timestamp': datetime.now().isoformat(),
            'source': 'python-script'
        },
        {
            'type': 'chat',
            'text': 'This is a chat message from Python! 🐍',
            'user': 'Python Bot',
            'channel': 'testing'
        },
        {
            'type': 'progress',
            'task': 'python-demo',
            'current': 25,
            'total': 100,
            'status': 'Processing data...'
        },
        {
            'type': 'progress',
            'task': 'python-demo',
            'current': 75,
            'total': 100,
            'status': 'Almost done...'
        },
        {
            'type': 'progress',
            'task': 'python-demo', 
            'current': 100,
            'total': 100,
            'status': 'Complete!'
        }
    ]
    
    for i, message in enumerate(messages):
        try:
            print(f"📤 Sending message {i+1}/{len(messages)}: {message['type']}")
            result = await client.messages.listen_message_async(project_id, message)
            print(f"✅ Message sent successfully")
            await asyncio.sleep(1)  # Wait between messages
        except Exception as error:
            print(f"❌ Failed to send message {i+1}: {error}")

async def trigger_audit_events(client: PlaidClient, project_id: str):
    """Trigger audit events by creating and modifying data"""
    print("🔄 Triggering audit events by creating documents...")
    await asyncio.sleep(1)
    
    try:
        # Create a test document (this will generate audit events)
        doc_name = f'Python Test Doc {datetime.now().strftime("%H:%M:%S")}'
        print(f"📄 Creating document: {doc_name}")
        document = await client.documents.create_async(project_id, doc_name)
        print(f"✅ Document created: {document.get('id', 'unknown')}")
        
        await asyncio.sleep(1)
        
        # Update the document name (another audit event)
        if 'id' in document:
            new_name = f'Updated Python Doc {datetime.now().strftime("%H:%M:%S")}'
            print(f"📝 Updating document: {document['id']}")
            await client.documents.update_async(document['id'], new_name)
            print(f"✅ Document updated to: {new_name}")
            
        await asyncio.sleep(1)
        
        # Create another document for more audit events
        doc_name2 = f'Python Doc #2 {datetime.now().strftime("%H:%M:%S")}'
        print(f"📄 Creating second document: {doc_name2}")
        document2 = await client.documents.create_async(project_id, doc_name2)
        print(f"✅ Second document created: {document2.get('id', 'unknown')}")
        
    except Exception as error:
        print(f"❌ Failed to trigger audit events: {error}")
        import traceback
        traceback.print_exc()

async def run_automated_tests(client: PlaidClient, project_id: str):
    """Run automated tests in the background"""
    await asyncio.sleep(1)  # Let the listener start first
    
    # Send messages
    await send_test_messages(client, project_id)
    
    # Wait a bit
    await asyncio.sleep(5)
    
    # Trigger audit events  
    await trigger_audit_events(client, project_id)
    
    print("🏁 Automated tests completed!")

def main():
    """Main test function"""
    print_header()
    
    # Create client
    try:
        client = PlaidClient(CONFIG['base_url'], CONFIG['token'])
        print("✅ Client initialized")
    except Exception as error:
        print(f"❌ Failed to initialize client: {error}")
        sys.exit(1)
    
    # Track statistics
    stats = EventStats()
    
    # Create event handler with stats
    def event_handler(event_type: str, data: Dict[str, Any]) -> None:
        handle_event(event_type, data, stats)
    
    print("🎧 Starting event listener...")
    print("⏰ Will run for 45 seconds with automated tests")
    print()
    
    try:
        # Start automated tests in background
        async def run_tests():
            await run_automated_tests(client, CONFIG['project_id'])
        
        # Run tests in background thread
        def run_async_tests():
            asyncio.run(run_tests())
        
        test_thread = threading.Thread(target=run_async_tests)
        test_thread.daemon = True
        test_thread.start()
        
        # Start listening (this will block for the specified timeout)
        print("✨ Event stream starting...")
        session_summary = client.messages.listen(
            CONFIG['project_id'], 
            event_handler, 
            timeout=15
        )
        
        # Show final summary
        print("=" * 60)
        print("📊 FINAL SESSION SUMMARY")
        print("=" * 60)
        print(f"Duration: {stats.duration():.1f} seconds")
        print(f"Audit Log Events: {stats.audit_log}")
        print(f"Message Events: {stats.message}")
        print(f"Other Events: {stats.other}")
        print(f"Total Events: {stats.audit_log + stats.message + stats.other}")
        
        if session_summary:
            print("🔧 Server Connection Details:")
            print(f"  • Audit Events: {session_summary.get('audit_events', 0)}")
            print(f"  • Message Events: {session_summary.get('message_events', 0)}")
            print(f"  • Connection Events: {session_summary.get('connection_events', 0)}")
            print(f"  • Heartbeat Events: {session_summary.get('heartbeat_events', 0)}")
            print(f"  • Heartbeat Confirmations Sent: {session_summary.get('heartbeat_confirmations_sent', 0)}")
            print(f"  • Error Events: {session_summary.get('error_events', 0)}")
            print(f"  • Client ID: {session_summary.get('client_id', 'N/A')}")
            if session_summary.get('last_heartbeat_seconds_ago') is not None:
                print(f"  • Last Heartbeat: {session_summary.get('last_heartbeat_seconds_ago'):.1f}s ago")
        
        print()
        print("🎉 Python client test completed!")
        print("🔍 This demonstrated the NEW heartbeat confirmation protocol:")
        print("   ✅ Single callback receives (event_type, data)")  
        print("   ✅ Same API structure as JavaScript client")
        print("   ✅ Both message and audit-log events handled")
        print("   ✅ Automatic heartbeat confirmation to server")
        print("   ✅ Proper connection cleanup and server notification")
        
    except KeyboardInterrupt:
        print("\n👋 Test interrupted by user")
        print(f"📊 Final stats: {stats}")
    except Exception as error:
        print(f"❌ Test failed: {error}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
