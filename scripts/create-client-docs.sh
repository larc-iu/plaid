#!/bin/bash

# Client Documentation Generation Script
# Creates documentation for auto-generated client libraries

set -euo pipefail

# Configuration
BUILD_DIR="docs-build"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Create JavaScript client documentation
create_js_docs() {
    print_status "Creating JavaScript client documentation..."
    
    cat > "$BUILD_DIR/clients/javascript/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>JavaScript Client - Plaid</title>
    <link rel="stylesheet" href="../../assets/style.css">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <nav>
        <a href="../../index.html">Home</a>
        <a href="../../manual/index.html">Manual</a>
        <a href="../../api/index.html">API</a>
        <a href="../index.html">Clients</a>
    </nav>
    <div class="container">
        <h1>JavaScript Client</h1>
        <p>Auto-generated JavaScript/TypeScript client for the Plaid API with full type safety and modern async/await support.</p>
        
        <h2>Features</h2>
        <ul>
            <li>✅ Full TypeScript support with complete type definitions</li>
            <li>✅ Modern async/await API</li>
            <li>✅ Automatic request/response transformation</li>
            <li>✅ Built-in error handling</li>
            <li>✅ Browser and Node.js compatible</li>
            <li>✅ Batch operation support</li>
            <li>✅ Document version tracking</li>
        </ul>
        
        <h2>Installation</h2>
        <pre><code># Via npm
npm install @plaid/client

# Via yarn
yarn add @plaid/client

# Via pnpm
pnpm add @plaid/client</code></pre>
        
        <h2>Quick Start</h2>
        <pre><code>import { PlaidClient } from '@plaid/client';

// Initialize client
const client = new PlaidClient('http://localhost:8085', 'your-jwt-token');

// List projects
const projects = await client.projects.list();
console.log('Projects:', projects);

// Create a new project
const newProject = await client.projects.create({
    name: 'My Annotation Project',
    description: 'A sample linguistic annotation project'
});

// Get a specific document
const document = await client.documents.get('doc-id-123');

// Create tokens with batch operations
await client.startBatch();
await client.tokens.create({ text: 'text-id', begin: 0, end: 5 });
await client.tokens.create({ text: 'text-id', begin: 6, end: 11 });
await client.commitBatch();</code></pre>
        
        <h2>Authentication</h2>
        <p>The client requires a JWT token for authentication. Obtain one by logging in:</p>
        <pre><code>// Login to get token
const response = await fetch('http://localhost:8085/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        username: 'your-username',
        password: 'your-password'
    })
});

const { token } = await response.json();
const client = new PlaidClient('http://localhost:8085', token);</code></pre>
        
        <h2>Batch Operations</h2>
        <p>For better performance when creating multiple entities, use batch operations:</p>
        <pre><code>// Start a batch
await client.startBatch();

// Queue multiple operations
await client.tokens.create({ text: 'text-1', begin: 0, end: 5 });
await client.tokens.create({ text: 'text-1', begin: 6, end: 11 });
await client.spans.create({ tokens: ['token-1'], value: 'NOUN' });

// Commit all operations at once
await client.commitBatch();</code></pre>
        
        <h2>Error Handling</h2>
        <pre><code>try {
    const project = await client.projects.get('non-existent-id');
} catch (error) {
    if (error.status === 404) {
        console.log('Project not found');
    } else if (error.status === 401) {
        console.log('Authentication required');
    } else {
        console.log('Error:', error.message);
    }
}</code></pre>
        
        <h2>TypeScript Support</h2>
        <p>The client includes comprehensive TypeScript definitions:</p>
        <pre><code>interface Project {
    id: string;
    name: string;
    description?: string;
    readers: string[];
    writers: string[];
    maintainers: string[];
}

interface Document {
    id: string;
    project: string;
    name: string;
    // ... other properties
}

// Full type safety
const project: Project = await client.projects.get('project-id');
const documents: Document[] = await client.documents.list({ project: project.id });</code></pre>
        
        <h2>Browser Usage</h2>
        <p>The client works in modern browsers with ES6 module support:</p>
        <pre><code>&lt;script type="module"&gt;
import { PlaidClient } from './node_modules/@plaid/client/index.js';

const client = new PlaidClient('http://localhost:8085', 'your-token');
const projects = await client.projects.list();
console.log(projects);
&lt;/script&gt;</code></pre>
        
        <h2>API Reference</h2>
        <p>For complete API documentation, see the <a href="../../api/index.html">API Reference</a>.</p>
    </div>
</body>
</html>
EOF
    
    print_success "JavaScript client documentation created"
}

# Create Python client documentation
create_python_docs() {
    print_status "Creating Python client documentation..."
    
    cat > "$BUILD_DIR/clients/python/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Python Client - Plaid</title>
    <link rel="stylesheet" href="../../assets/style.css">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <nav>
        <a href="../../index.html">Home</a>
        <a href="../../manual/index.html">Manual</a>
        <a href="../../api/index.html">API</a>
        <a href="../index.html">Clients</a>
    </nav>
    <div class="container">
        <h1>Python Client</h1>
        <p>Auto-generated Python client for the Plaid API with full type hints and async support.</p>
        
        <h2>Features</h2>
        <ul>
            <li>✅ Complete type hints with mypy support</li>
            <li>✅ Both sync and async APIs</li>
            <li>✅ Automatic request/response serialization</li>
            <li>✅ Built-in error handling with custom exceptions</li>
            <li>✅ Python 3.8+ compatibility</li>
            <li>✅ Batch operation support</li>
            <li>✅ Context manager support</li>
        </ul>
        
        <h2>Installation</h2>
        <pre><code># Via pip
pip install plaid-client

# Via poetry
poetry add plaid-client

# From source
pip install git+https://github.com/your-org/plaid-python-client.git</code></pre>
        
        <h2>Quick Start</h2>
        <pre><code>from plaid_client import PlaidClient

# Initialize client
client = PlaidClient('http://localhost:8085', 'your-jwt-token')

# List projects
projects = client.projects.list()
print(f"Found {len(projects)} projects")

# Create a new project
new_project = client.projects.create(
    name='My Annotation Project',
    description='A sample linguistic annotation project'
)

# Get a specific document
document = client.documents.get('doc-id-123')

# Create tokens with context manager
with client.batch():
    client.tokens.create(text='text-id', begin=0, end=5)
    client.tokens.create(text='text-id', begin=6, end=11)</code></pre>
        
        <h2>Async Support</h2>
        <p>Use the async client for better performance in async applications:</p>
        <pre><code>import asyncio
from plaid_client import AsyncPlaidClient

async def main():
    async with AsyncPlaidClient('http://localhost:8085', 'your-token') as client:
        projects = await client.projects.list()
        
        # Concurrent operations
        tasks = [
            client.documents.get(doc_id) 
            for doc_id in ['doc-1', 'doc-2', 'doc-3']
        ]
        documents = await asyncio.gather(*tasks)
        
        return documents

# Run async code
documents = asyncio.run(main())</code></pre>
        
        <h2>Authentication</h2>
        <pre><code>import requests
from plaid_client import PlaidClient

# Login to get token
response = requests.post('http://localhost:8085/api/v1/login', json={
    'username': 'your-username',
    'password': 'your-password'
})
token = response.json()['token']

# Create authenticated client
client = PlaidClient('http://localhost:8085', token)</code></pre>
        
        <h2>Batch Operations</h2>
        <p>Use batch operations for efficient bulk operations:</p>
        <pre><code># Context manager approach
with client.batch():
    client.tokens.create(text='text-1', begin=0, end=5)
    client.tokens.create(text='text-1', begin=6, end=11)
    client.spans.create(tokens=['token-1'], value='NOUN')

# Manual batch control
client.start_batch()
client.tokens.create(text='text-1', begin=0, end=5)
client.tokens.create(text='text-1', begin=6, end=11)
client.commit_batch()</code></pre>
        
        <h2>Error Handling</h2>
        <pre><code>from plaid_client import PlaidClient, PlaidNotFoundError, PlaidAuthError

client = PlaidClient('http://localhost:8085', 'your-token')

try:
    project = client.projects.get('non-existent-id')
except PlaidNotFoundError:
    print("Project not found")
except PlaidAuthError:
    print("Authentication required")
except Exception as e:
    print(f"Unexpected error: {e}")</code></pre>
        
        <h2>Type Hints</h2>
        <p>The client includes comprehensive type hints for better IDE support:</p>
        <pre><code>from typing import List, Optional
from plaid_client import PlaidClient
from plaid_client.types import Project, Document

client: PlaidClient = PlaidClient('http://localhost:8085', 'token')

# Type-safe operations
project: Project = client.projects.get('project-id')
documents: List[Document] = client.documents.list(project=project.id)

# Optional parameters are properly typed
document: Optional[Document] = client.documents.get('maybe-missing-id')</code></pre>
        
        <h2>Configuration</h2>
        <pre><code>from plaid_client import PlaidClient

# Custom timeout and retry settings
client = PlaidClient(
    base_url='http://localhost:8085',
    token='your-token',
    timeout=30.0,
    max_retries=3,
    retry_delay=1.0
)

# Custom headers
client = PlaidClient(
    base_url='http://localhost:8085',
    token='your-token',
    headers={'User-Agent': 'MyApp/1.0'}
)</code></pre>
        
        <h2>Advanced Usage</h2>
        <h3>Custom Session</h3>
        <pre><code>import requests
from plaid_client import PlaidClient

# Use custom session with connection pooling
session = requests.Session()
session.mount('http://', requests.adapters.HTTPAdapter(pool_connections=20))

client = PlaidClient('http://localhost:8085', 'token', session=session)</code></pre>
        
        <h3>Streaming Large Datasets</h3>
        <pre><code># Stream large datasets efficiently
for batch in client.documents.list_paginated(project='large-project', page_size=100):
    for document in batch:
        process_document(document)</code></pre>
        
        <h2>API Reference</h2>
        <p>For complete API documentation, see the <a href="../../api/index.html">API Reference</a>.</p>
    </div>
</body>
</html>
EOF
    
    print_success "Python client documentation created"
}

# Create main clients index page
create_clients_index() {
    print_status "Creating clients index page..."
    
    cat > "$BUILD_DIR/clients/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Client Libraries - Plaid</title>
    <link rel="stylesheet" href="../assets/style.css">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <nav>
        <a href="../index.html">Home</a>
        <a href="../manual/index.html">Manual</a>
        <a href="../api/index.html">API</a>
        <a href="index.html" class="active">Clients</a>
    </nav>
    <div class="container">
        <h1>Client Libraries</h1>
        <p>Auto-generated, type-safe client libraries for the Plaid API. These clients provide convenient, idiomatic interfaces for your preferred programming language.</p>
        
        <div class="client-grid">
            <div class="client-card">
                <h3>🟨 JavaScript / TypeScript</h3>
                <p>Modern async/await API with complete TypeScript definitions. Works in both Node.js and browsers.</p>
                <ul>
                    <li>Full TypeScript support</li>
                    <li>Async/await API</li>
                    <li>Batch operations</li>
                    <li>Error handling</li>
                    <li>Browser compatible</li>
                </ul>
                <a href="javascript/index.html" class="button">View JS Docs</a>
                <a href="../api/index.html" class="button secondary">API Reference</a>
            </div>
            
            <div class="client-card">
                <h3>🐍 Python</h3>
                <p>Pythonic client with type hints and both sync/async support. Compatible with Python 3.8+.</p>
                <ul>
                    <li>Type hints & mypy support</li>
                    <li>Sync and async APIs</li>
                    <li>Context managers</li>
                    <li>Custom exceptions</li>
                    <li>Streaming support</li>
                </ul>
                <a href="python/index.html" class="button">View Python Docs</a>
                <a href="../api/index.html" class="button secondary">API Reference</a>
            </div>
        </div>
        
        <h2>Getting Started</h2>
        <p>All client libraries follow similar patterns for authentication and basic usage:</p>
        
        <h3>1. Install the Client</h3>
        <div class="client-grid">
            <div>
                <h4>JavaScript</h4>
                <pre><code>npm install @plaid/client</code></pre>
            </div>
            <div>
                <h4>Python</h4>
                <pre><code>pip install plaid-client</code></pre>
            </div>
        </div>
        
        <h3>2. Authenticate</h3>
        <div class="client-grid">
            <div>
                <h4>JavaScript</h4>
                <pre><code>import { PlaidClient } from '@plaid/client';

const client = new PlaidClient(
    'http://localhost:8085',
    'your-jwt-token'
);</code></pre>
            </div>
            <div>
                <h4>Python</h4>
                <pre><code>from plaid_client import PlaidClient

client = PlaidClient(
    'http://localhost:8085',
    'your-jwt-token'
)</code></pre>
            </div>
        </div>
        
        <h3>3. Make API Calls</h3>
        <div class="client-grid">
            <div>
                <h4>JavaScript</h4>
                <pre><code>// List projects
const projects = await client.projects.list();

// Create a document
const doc = await client.documents.create({
    project: 'project-id',
    name: 'My Document'
});</code></pre>
            </div>
            <div>
                <h4>Python</h4>
                <pre><code># List projects
projects = client.projects.list()

# Create a document
doc = client.documents.create(
    project='project-id',
    name='My Document'
)</code></pre>
            </div>
        </div>
        
        <h2>Common Patterns</h2>
        
        <h3>Batch Operations</h3>
        <p>For better performance when creating multiple entities, both clients support batch operations:</p>
        
        <div class="client-grid">
            <div>
                <h4>JavaScript</h4>
                <pre><code>await client.startBatch();
await client.tokens.create({...});
await client.tokens.create({...});
await client.commitBatch();</code></pre>
            </div>
            <div>
                <h4>Python</h4>
                <pre><code>with client.batch():
    client.tokens.create(...)
    client.tokens.create(...)</code></pre>
            </div>
        </div>
        
        <h3>Error Handling</h3>
        <p>Both clients provide structured error handling:</p>
        
        <div class="client-grid">
            <div>
                <h4>JavaScript</h4>
                <pre><code>try {
    const project = await client.projects.get('id');
} catch (error) {
    if (error.status === 404) {
        console.log('Not found');
    }
}</code></pre>
            </div>
            <div>
                <h4>Python</h4>
                <pre><code>try:
    project = client.projects.get('id')
except PlaidNotFoundError:
    print('Not found')</code></pre>
            </div>
        </div>
        
        <h2>API Coverage</h2>
        <p>Both client libraries provide complete coverage of the Plaid API:</p>
        
        <table>
            <thead>
                <tr>
                    <th>Resource</th>
                    <th>Operations</th>
                    <th>Description</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><strong>Projects</strong></td>
                    <td>CRUD, Access Control</td>
                    <td>Project management and permissions</td>
                </tr>
                <tr>
                    <td><strong>Documents</strong></td>
                    <td>CRUD, Media Attachments</td>
                    <td>Document lifecycle management</td>
                </tr>
                <tr>
                    <td><strong>Layers</strong></td>
                    <td>CRUD, Configuration</td>
                    <td>Layer setup and management</td>
                </tr>
                <tr>
                    <td><strong>Texts</strong></td>
                    <td>CRUD, History</td>
                    <td>Text content management</td>
                </tr>
                <tr>
                    <td><strong>Tokens</strong></td>
                    <td>CRUD, Batch Operations</td>
                    <td>Token annotation and editing</td>
                </tr>
                <tr>
                    <td><strong>Spans</strong></td>
                    <td>CRUD, Validation</td>
                    <td>Span annotation over tokens</td>
                </tr>
                <tr>
                    <td><strong>Relations</strong></td>
                    <td>CRUD, Graph Operations</td>
                    <td>Relationships between spans</td>
                </tr>
                <tr>
                    <td><strong>Users</strong></td>
                    <td>Authentication, Profile</td>
                    <td>User management and auth</td>
                </tr>
            </tbody>
        </table>
        
        <h2>Need Help?</h2>
        <p>If you need assistance with the client libraries:</p>
        <ul>
            <li>Check the <a href="../manual/index.html">Technical Manual</a> for detailed examples</li>
            <li>Browse the <a href="../api/index.html">API Reference</a> for endpoint details</li>
            <li>Report issues on <a href="https://github.com/your-org/plaid/issues">GitHub</a></li>
            <li>Join discussions on <a href="https://github.com/your-org/plaid/discussions">GitHub Discussions</a></li>
        </ul>
    </div>
</body>
</html>
EOF
    
    print_success "Clients index page created"
}

# Main execution
main() {
    create_js_docs
    create_python_docs
    create_clients_index
    print_success "Client documentation generation completed!"
}

# Run main function
main "$@"