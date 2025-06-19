/**
 * SSE Listen API Test for Browser Dev Console
 * 
 * Copy and paste this entire script into your browser's dev console
 * to test the SSE listen functionality.
 * 
 * Prerequisites:
 * - The dev server should be running on http://localhost:8085
 * - client.js should already be loaded (PlaidClient available)
 * - You should have valid credentials to pass to testSSEListen()
 */

// Configuration 
const BASE_URL = 'http://localhost:8085';

async function testSSEListen(username, password) {
  if (!username || !password) {
    console.error('❌ Usage: testSSEListen("your-username", "your-password")');
    console.log('💡 Example: testSSEListen("admin", "password123")');
    return;
  }

  console.log('🚀 Starting Fetch SSE Listen API Test (Python-like Connection Cleanup)...');
  
  try {
    // Step 1: Authenticate and get a client
    console.log('📝 Step 1: Authenticating...');
    const client = await PlaidClient.login(BASE_URL, username, password);
    console.log('✅ Authentication successful');
    
    // Step 2: Get or create a project
    console.log('📝 Step 2: Getting projects...');
    const projects = await client.projects.list();
    console.log('📊 Found projects:', projects);
    
    let projectId;
    if (projects.length > 0) {
      projectId = projects[0].id;
      console.log(`✅ Using existing project: ${projectId}`);
    } else {
      console.log('📝 Creating new test project...');
      const newProject = await client.projects.create('SSE Test Project');
      projectId = newProject.id;
      console.log(`✅ Created new project: ${projectId}`);
    }
    
    // Step 3: Set up event listener with NEW Fetch-based SSE implementation
    console.log('📝 Step 3: Setting up Fetch SSE listener (replaces EventSource)...');
    let eventCount = 0;
    
    const sseConnection = client.projects.listen(
      projectId, 
      (eventType, data) => {
        eventCount++;
        console.log(`📡 Event #${eventCount} - Type: ${eventType}`, data);
        
        // You can handle specific event types here
        switch (eventType) {
          case 'audit-log':
            console.log('🔍 Audit event:', data);
            break;
          case 'message':
            console.log('💬 Message event:', data);
            break;
          default:
            console.log('❓ Unknown event type:', eventType, data);
        }
      },
      30 // 30 second timeout
    );
    
    console.log('✅ Fetch SSE connection started (Python-like behavior)');
    console.log('📢 You can now:');
    console.log('   1. Perform operations on the project to generate audit events');
    console.log('   2. Send test messages using client.projects.sendMessage()');
    console.log('   3. Watch heartbeat confirmations in the console');
    console.log('');
    console.log('🔧 Test commands you can run:');
    console.log(`   testSendMessage('${projectId}');`);
    console.log(`   testAuditEvent('${projectId}');`);
    console.log('   sseConnection.close(); // to stop listening');
    console.log('');
    console.log('🔥 NEW: Fetch-based SSE (Python-like Connection Cleanup)');
    console.log('   - Uses Fetch + ReadableStream instead of EventSource');
    console.log('   - AbortController enables immediate server cleanup');
    console.log('   - Server detects disconnection immediately when closed');
    console.log('   - No more stale connections like with EventSource!');
    console.log('   - Automatic heartbeat confirmation system included');
    
    // Store references globally for easy access
    window.testSSEConnection = sseConnection;
    window.testProjectId = projectId;
    window.testClient = client;
    
    // Set up auto-close after timeout
    setTimeout(() => {
      console.log('⏰ 30 seconds elapsed, closing connection...');
      sseConnection.close();
      console.log(`📊 Test completed! Received ${eventCount} events total.`);
      console.log(`📈 Final stats:`, sseConnection.getStats());
      console.log('🎉 Server should have detected disconnection immediately!');
    }, 30000);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error.status === 401) {
      console.error('💡 Tip: Check your username and password');
    }
  }
}

// Helper function to send a test message
async function testSendMessage(projectId = window.testProjectId) {
  if (!window.testClient) {
    console.error('❌ No test client available. Run testSSEListen() first.');
    return;
  }
  
  console.log('📤 Sending test message...');
  const message = {
    type: 'test',
    timestamp: new Date().toISOString(),
    message: 'Hello from browser dev console!'
  };
  
  try {
    await window.testClient.projects.sendMessage(projectId, message);
    console.log('✅ Test message sent:', message);
  } catch (error) {
    console.error('❌ Failed to send message:', error);
  }
}

// Helper function to generate an audit event
async function testAuditEvent(projectId = window.testProjectId) {
  if (!window.testClient) {
    console.error('❌ No test client available. Run testSSEListen() first.');
    return;
  }
  
  console.log('📝 Creating test document to generate audit event...');
  try {
    const doc = await window.testClient.documents.create(projectId, `Test Doc ${Date.now()}`);
    console.log('✅ Test document created:', doc);
    console.log('👀 This should have generated an audit-log event!');
  } catch (error) {
    console.error('❌ Failed to create document:', error);
  }
}

// Start the test
console.log('🎯 Fetch SSE Test Script Loaded (Python-like Connection Cleanup)!');
console.log('🚀 Run testSSEListen("username", "password") to start the test');
console.log('💡 Example: testSSEListen("admin", "mypassword")');
console.log('');
console.log('🔥 NEW Fetch-based SSE Features:');
console.log('  - Uses Fetch + ReadableStream instead of EventSource');
console.log('  - AbortController enables immediate server cleanup');
console.log('  - Automatic heartbeat confirmation every 3 seconds');
console.log('  - Server detects disconnection immediately when closed');
console.log('  - No more stale connection accumulation!');
console.log('');

// Expose the test function globally
window.testSSEListen = testSSEListen;
window.testSendMessage = testSendMessage;  
window.testAuditEvent = testAuditEvent;

// Add helper for getting connection stats
window.getSSEConnectionStats = () => {
  if (window.testSSEConnection && window.testSSEConnection.getStats) {
    return window.testSSEConnection.getStats();
  } else {
    console.log('❌ No active SSE connection. Run testSSEListen() first.');
    return null;
  }
};

// Legacy alias for compatibility
window.getEventSourceStats = window.getSSEConnectionStats;