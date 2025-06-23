# Universal Dependencies Tree Editor - Detailed Specification

## Project Overview

This specification outlines a React-based demo application for editing Universal Dependencies trees using the Plaid linguistic annotation platform. The application demonstrates Plaid's capabilities for managing hierarchical linguistic data structures while providing a user-friendly interface for CoNLL-U format annotation.

**Target Audience**: Technically savvy linguistics PhD students with some JavaScript/Python familiarity but not necessarily CS degrees.

**Implementation Status**: **Phase 1-3 Complete** (Authentication, Project Management, Text & Token Management with full Plaid API integration)

**Remaining Work**: Phase 4-6 (Annotation Interface, Dependency Tree Visualization, CoNLL-U Import/Export)

## Background & Context

- **Target Format**: CoNLL-U (Universal Dependencies format)
- **Platform**: Plaid (Clojure-based linguistic annotation platform)
- **Database**: XTDB (immutable database with full history)
- **Frontend**: React application
- **Backend**: Plaid REST API (running on plaid.jar)
- **Authentication**: JWT tokens via Plaid's auth system

## Data Model Specification

### CoNLL-U Format Support
The application will support all CoNLL-U columns except DEPS and MISC:
- **ID**: Token index (1-based, with support for empty nodes like 10.1, 10.2, or _ for words)
- **FORM**: Word form (derived from text for regular tokens)
- **LEMMA**: Lemma annotation
- **UPOS**: Universal part-of-speech tag
- **XPOS**: Language-specific part-of-speech tag
- **FEATS**: Morphological features (key-value pairs)
- **HEAD**: Head token ID for dependency relations
- **DEPREL**: Dependency relation label
- **DEPS**: Not supported (will be blank "_" on export)
- **MISC**: Not supported (will be blank "_" on export)

### Plaid Layer Configuration

Every UD project will use this exact layer hierarchy:

```
Project
├── TextLayer: "Text" (baseline text content)
    └── TokenLayer: "Token" (for regularly indexed tokens)
        ├── SpanLayer: "Ellipsis Form" (ONLY for empty nodes, one-to-one)
        ├── SpanLayer: "Multi-word Tokens" (each span indicates a multi-word token)
        ├── SpanLayer: "Lemma" (one-to-one, default = token form)
        │   └── RelationLayer: "Relation" (HEAD+DEPREL, unique source/target pairs)
        ├── SpanLayer: "XPOS" (one-to-one)
        ├── SpanLayer: "UPOS" (one-to-one)
        ├── SpanLayer: "Features" (many-to-one, value format: "key:value")
        ├── SpanLayer: "Head" (for storing HEAD references)
        └── SpanLayer: "Sentence" (for demarcating sentences: a single span means "begin a new sentence here". Metadata for each span will hold sentence metadata from UD.)
```

### Token Handling Specifics
- **Regular Tokens**: Derived from text with begin/end indices
- **Empty Nodes**: Zero-length tokens using `precedence` feature for 1-based indexing
- **Multi-word Tokens**: Supported via "Multi-word Tokens" SpanLayer (in scope for first version)
- **Token Preservation**: Existing tokens must be preserved during re-tokenization

### Sentence Boundaries
- **Initial Segmentation**: Sentence boundaries determined by presence of one or more newlines in original text
- **Editable**: Users can modify sentence boundaries in the text/token editor interface
- **Storage**: Managed via "Sentence" SpanLayer with metadata for sentence-level comments

## User Interface Specification

### 1. Login Screen
- **Purpose**: JWT authentication using Plaid's user system
- **Fields**: Username, Password
- **API**: `POST /api/v1/login`
- **Behavior**: 
  - Store JWT token in localStorage/sessionStorage
  - Redirect to project list on success
  - Show error messages on failure
- **Access Control**: No other parts accessible until authenticated

### 2. Project List Screen
- **Purpose**: Manage UD projects
- **Features**:
  - List all accessible projects with names and metadata
  - Delete projects (with confirmation)
  - Create new UD projects with auto-layer setup
- **API Endpoints**:
  - `GET /api/v1/projects` (list accessible projects)
  - `DELETE /api/v1/projects/{id}` (delete project)
  - `POST /api/v1/projects` (create project)
  - Layer creation APIs for auto-setup

### 3. Document List Screen
- **Purpose**: Manage documents within a project
- **Features**:
  - List all documents in selected project
  - Delete documents (with confirmation)
  - Create new documents
  - Navigate to text/token editor
- **API Endpoints**:
  - `GET /api/v1/projects/{project-id}/documents`
  - `DELETE /api/v1/documents/{id}`
  - `POST /api/v1/documents`

### 4. Text and Token Editor Screen ✅ **COMPLETED**
- **Purpose**: Text editing and tokenization management
- **Components**:
  - **Text Editor**: ✅ 
    - Rich text input with manual save functionality
    - Real-time text updates via Plaid API
    - Visual indication of save status
  - **Token Visualizer**: ✅
    - Display current tokens with boundaries and IDs
    - Show token indices, forms, and positions
    - Interactive hover details
  - **Tokenization Controls**: ✅
    - "Whitespace Tokenize" button with real Plaid token creation
    - "Clear Tokens" functionality
    - Real-time token count display
- **Technical Implementation**: ✅
  - Full Plaid API integration for text and token persistence
  - Proper layer discovery and token-text relationships
  - Character position tracking with begin/end indices

### 5. Annotation Editor Screen 🚧 **TODO - PHASE 4**
- **Purpose**: Sentence-by-sentence UD annotation using existing Plaid span layers
- **Layout**: Tabular interface with columns for each CoNLL-U field
- **Features**:
  - **Sentence Navigation**: Previous/Next sentence buttons
  - **LEMMA Editing**: Text input (defaults to token form) → "Lemma" span layer
  - **XPOS Editing**: Text input for language-specific POS → "XPOS" span layer
  - **UPOS Editing**: Dropdown or text input for universal POS → "UPOS" span layer
  - **FEATS Editing**: → "Features" span layer
    - Key-value pair interface with "key:value" format
    - Add/remove feature pairs
    - Validation to prevent duplicate keys
  - **HEAD+DEPREL Editing**: → "Relation" relation layer
    - Integration with dependency tree visualization (Phase 5)
    - Dropdown for DEPREL labels
    - Cycle detection and prevention
    - Single head constraint enforcement

### 6. Dependency Tree Visualization 🚧 **TODO - PHASE 5**
- **Purpose**: Interactive visual editing of dependency relations using Plaid relation layer
- **Technical Implementation**: 
  - **Reference Implementation**: Follow the approach in https://raw.githubusercontent.com/gucorpling/midas-loop-ui/refs/heads/master/src/ud-tree/ud-tree/components.js
  - Use D3.js for SVG-based tree rendering and interaction
  - Implement click-and-drag interface for relation editing
  - Connect to existing "Relation" relation layer
- **Features**:
  - Visual tree rendering with arc-based dependency display
  - Click source token, then target token to create relation
  - Drag existing relations to change head
  - DEPREL label editing (dropdown or text input)
  - Basic validation feedback (cycle prevention, single head constraint)
  - Support for ROOT relations (head = 0)
  - Handle multi-word tokens and empty nodes in visualization

## Technical Architecture

### Frontend Stack
- **Framework**: React 18+
- **Routing**: React Router v6
- **State Management**: React Context + useReducer pattern
- **HTTP Client**: Generated PlaidClient from target/clients/client.js (with TypeScript definitions)
- **Styling**: CSS Modules or Styled Components (minimal dependencies)
- **Tree Visualization**: D3.js for dependency trees
- **Build Tool**: Vite

### Component Structure
```
src/
├── components/
│   ├── auth/
│   │   ├── LoginForm.jsx
│   │   └── ProtectedRoute.jsx
│   ├── projects/
│   │   ├── ProjectList.jsx
│   │   └── ProjectForm.jsx
│   ├── documents/
│   │   ├── DocumentList.jsx
│   │   └── DocumentForm.jsx
│   ├── editor/
│   │   ├── TextEditor.jsx
│   │   ├── TokenVisualizer.jsx
│   │   ├── AnnotationGrid.jsx
│   │   ├── DependencyTree.jsx
│   │   └── SentenceNavigator.jsx
│   └── common/
│       ├── Layout.jsx
│       ├── Navigation.jsx
│       └── ErrorBoundary.jsx
├── contexts/
│   ├── AuthContext.jsx
│   └── ProjectContext.jsx
├── services/
│   ├── plaidClient.js (symlink to generated client)
│   ├── plaidClient.d.ts (symlink to TypeScript definitions)
│   ├── auth.js
│   ├── projects.js
│   ├── documents.js
│   └── annotations.js
├── utils/
│   ├── conllu.js (export/import functions)
│   ├── validation.js
│   └── tokenization.js
└── App.jsx
```

### State Management Patterns
1. **Authentication State**: Global context with JWT token and user info
2. **Project State**: Current project, documents, and layer configurations
3. **Editor State**: Current document, text, tokens, and annotations
4. **UI State**: Loading states, error messages, form validation

## API Integration

### Required Plaid API Endpoints
- **Authentication**: `POST /api/v1/login`
- **Projects**: `GET|POST|DELETE /api/v1/projects`
- **Documents**: `GET|POST|DELETE /api/v1/documents`
- **Layers**: `GET|POST /api/v1/text-layers`, `token-layers`, `span-layers`, `relation-layers`
- **Texts**: `GET|PUT /api/v1/texts/{id}`
- **Tokens**: `GET|POST|PUT|DELETE /api/v1/tokens`
- **Spans**: `GET|POST|PUT|DELETE /api/v1/spans`
- **Relations**: `GET|POST|PUT|DELETE /api/v1/relations`

### Data Flow Examples

#### Project Creation with Layer Setup
```javascript
// Get authenticated client
const client = authService.getClient();

// 1. Create project
const project = await client.projects.create('UD Project');

// 2. Create text layer
const textLayer = await client.textLayers.create(project.id, 'Text');

// 3. Create token layer
const tokenLayer = await client.tokenLayers.create(textLayer.id, 'Token');

// 4. Create span layers
const spanLayers = await Promise.all([
  client.spanLayers.create(tokenLayer.id, 'Ellipsis Form'),
  client.spanLayers.create(tokenLayer.id, 'Lemma'),
  client.spanLayers.create(tokenLayer.id, 'XPOS'),
  client.spanLayers.create(tokenLayer.id, 'UPOS'),
  client.spanLayers.create(tokenLayer.id, 'Features'),
  client.spanLayers.create(tokenLayer.id, 'Head'),
  client.spanLayers.create(tokenLayer.id, 'Multi-word Tokens'),
  client.spanLayers.create(tokenLayer.id, 'Sentence')
]);

// 5. Create relation layer
const lemmaLayer = spanLayers.find(l => l.name === 'Lemma');
const relationLayer = await client.relationLayers.create(lemmaLayer.id, 'Relation');
```

#### Annotation Update Flow
```javascript
// Update LEMMA
await client.spans.update(lemmaSpanId, newLemmaValue);

// Create dependency relation
await client.relations.create(
  relationLayerId,
  sourceSpanId,
  targetSpanId,
  deprelValue
);
```

## CoNLL-U Integration 🚧 **TODO - PHASE 6**

Both import and export functionality will be implemented in JavaScript within the React application using the existing Plaid layer structure.

### Export Process
1. Use GET requests to query all layers for the document
2. Build token index mapping (including multi-word tokens and empty nodes)
3. Extract annotations for each token from corresponding spans
4. Generate CoNLL-U format with proper column alignment
5. Include sentence metadata as comments (from "Sentence" SpanLayer metadata)
6. Provide download functionality for the generated CoNLL-U file

### Import Process
1. Parse uploaded CoNLL-U file into structured data (JavaScript)
2. Extract text content, tokens, and all annotation layers
3. Use Plaid's bulk operation API to create all entities
4. **Error Handling**: Abort entire import if any API request fails (atomic operation)
5. Create document structure:
   - Text content from reconstructed token forms
   - Tokens with proper indices and precedence
   - Spans for all annotation types (LEMMA, UPOS, XPOS, FEATS, etc.)
   - Relations for dependency structure
   - Sentence boundary spans with metadata

### Example CoNLL-U Output
```
# sent_id = 1
# text = The quick brown fox jumps.
1	The	the	DET	DT	Definite=Def|PronType=Art	4	det	_	_
2	quick	quick	ADJ	JJ	_	4	amod	_	_
3	brown	brown	ADJ	JJ	_	4	amod	_	_
4	fox	fox	NOUN	NN	Number=Sing	5	nsubj	_	_
5	jumps	jump	VERB	VBZ	Mood=Ind|Number=Sing|Person=3|Tense=Pres|VerbForm=Fin	0	root	_	_
6	.	.	PUNCT	.	_	5	punct	_	_
```

## Implementation Considerations

### Data Validation
Focus on basic structural constraints only:
- Prevent dependency cycles in HEAD relations
- Ensure single head per token (except ROOT connections)
- Validate FEATS key-value format ("key:value")
- Enforce one-to-one span-to-token relationships for POS tags (UPOS, XPOS)
- Check token boundary consistency within text
- **Note**: No UD-specific linguistic validation rules (e.g., POS-dependency compatibility)

### Performance Optimization
- Debounced text editing to reduce API calls
- Efficient re-rendering with React.memo
- Batch annotation updates where possible
- Local state management for UI responsiveness

### Error Handling
- Network error recovery
- Validation error display
- Graceful degradation for missing data
- User-friendly error messages

### Accessibility
- Keyboard navigation for tree editing
- Screen reader support for complex interfaces
- Color-blind friendly visualization
- High contrast mode support

## Future Enhancements

1. **Enhanced Visualization**: More sophisticated tree layouts and rendering options
2. **Collaborative Editing**: Real-time collaboration features
3. **UD Linguistic Validation**: Configurable linguistic validation rules
4. **Undo/Redo**: Full editing history leveraging Plaid's immutable database
5. **Search and Filter**: Find tokens by annotation values
6. **Batch Operations**: Bulk annotation updates across documents
7. **Advanced Import/Export**: Support for additional formats (e.g., XML, JSON-LD)
8. **Performance Optimization**: Lazy loading for large documents

## Testing Strategy

### Unit Tests
- CoNLL-U parsing and generation
- Validation functions
- API service functions
- Utility functions

### Integration Tests
- Authentication flow
- Project creation with layers
- End-to-end annotation workflow
- API error handling

### Manual Testing
- Cross-browser compatibility
- Mobile responsiveness
- Accessibility compliance
- Performance with large documents

## Deployment Considerations

### Proof-of-Concept Setup (Flask Reverse Proxy)

Since this is a proof-of-concept demo, we'll use a simple Flask-based reverse proxy to serve the React build and handle API requests. This approach avoids CORS issues entirely and keeps deployment simple.

#### Server Implementation
```python
# server.py
from flask import Flask, request, send_from_directory, jsonify
import requests
import os
from urllib.parse import urljoin

app = Flask(__name__, static_folder='build', static_url_path='')

# Configuration
PLAID_URL = os.environ.get('PLAID_URL', 'http://localhost:8085')
PORT = int(os.environ.get('PORT', 3000))

@app.route('/api/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy_to_plaid(path):
    """Proxy all /api requests to Plaid server"""
    url = urljoin(PLAID_URL, f'/api/{path}')
    
    # Forward the request
    resp = requests.request(
        method=request.method,
        url=url,
        headers={k: v for k, v in request.headers if k.lower() != 'host'},
        data=request.get_data(),
        params=request.args,
        allow_redirects=False
    )
    
    # Return the response
    response = app.response_class(
        response=resp.content,
        status=resp.status_code,
        headers=dict(resp.headers)
    )
    return response

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_react_app(path):
    """Serve React app static files"""
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    else:
        # Handle React routing - always serve index.html for unknown routes
        return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    print(f"Starting server on port {PORT}")
    print(f"Proxying /api requests to {PLAID_URL}")
    app.run(host='0.0.0.0', port=PORT, debug=True)
```

#### Dependencies
```
# requirements.txt
Flask==2.3.3
requests==2.31.0
```

#### Usage
```bash
# 1. Build React application
npm run build

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Start Plaid server (in separate terminal)
java -jar plaid.jar

# 4. Start Flask proxy server
python server.py

# Or with custom Plaid URL
PLAID_URL=http://localhost:8080 python server.py
```

#### Benefits of This Approach
- **No CORS issues**: All requests appear to come from same origin
- **Simple deployment**: Single Python command to start everything
- **Familiar to Python developers**: No Node.js knowledge required
- **Easy debugging**: Can add logging/middleware to Flask server
- **Environment flexibility**: Easy to configure different Plaid server URLs

### Development Workflow
1. Start Plaid server: `java -jar plaid.jar`
2. Develop React app with `npm start` (uses Vite/CRA proxy for development)
3. For testing full deployment: `npm run build && python server.py`

### Future Production Considerations
- Static build deployment (Netlify, Vercel, etc.)
- Plaid server deployment with proper configuration
- HTTPS requirement for JWT security
- Environment-specific configuration

## Questions for Clarification

1. **CoNLL-U Import**: Should the application support importing existing CoNLL-U files?
2. **Multi-word Tokens**: Are complex tokenization scenarios required initially?
3. **Sentence Boundaries**: How should sentence segmentation be handled and stored?
4. **Project Templates**: Should there be different project templates for different languages?
5. **Empty Node Management**: What UI patterns should be used for creating/managing empty nodes?
6. **Validation Rules**: Should linguistic validation rules be configurable or hardcoded?
7. **Collaboration**: Are multi-user editing scenarios important?
8. **Performance**: What are the expected document sizes (number of tokens/sentences)?

This specification provides a comprehensive foundation for implementing the Universal Dependencies tree editor while showcasing Plaid's capabilities as a linguistic annotation platform.
