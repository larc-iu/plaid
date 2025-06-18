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

  console.log('🚀 Starting SSE Listen API Test...');
  
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
    
    // Step 3: Set up event listener
    console.log('📝 Step 3: Setting up SSE listener...');
    let eventCount = 0;
    
    const eventSource = client.projects.listen(
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
    
    console.log('✅ SSE listener started. Listening for events...');
    console.log('📢 You can now:');
    console.log('   1. Perform operations on the project to generate audit events');
    console.log('   2. Send test messages using client.projects.sendMessage()');
    console.log('   3. Wait to see heartbeat events (every 3 seconds)');
    console.log('');
    console.log('🔧 Test commands you can run:');
    console.log(`   testSendMessage('${projectId}');`);
    console.log(`   testAuditEvent('${projectId}');`);
    console.log('   eventSource.close(); // to stop listening');
    
    // Store references globally for easy access
    window.testEventSource = eventSource;
    window.testProjectId = projectId;
    window.testClient = client;
    
    // Set up auto-close after timeout
    setTimeout(() => {
      console.log('⏰ 30 seconds elapsed, closing connection...');
      eventSource.close();
      console.log(`📊 Test completed! Received ${eventCount} events total.`);
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
console.log('🎯 SSE Test Script Loaded!');
console.log('🚀 Run testSSEListen("username", "password") to start the test');
console.log('💡 Example: testSSEListen("admin", "mypassword")');
console.log('');

// Expose the test function globally
window.testSSEListen = testSSEListen;
window.testSendMessage = testSendMessage;  
window.testAuditEvent = testAuditEvent;