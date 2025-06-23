# UD Editor Development Handoff

## Current Status (Phase 3 Complete)

The Universal Dependencies Tree Editor has been successfully implemented through **Phase 3** with full Plaid API integration. All basic functionality is working with real data persistence.

## ✅ What's Been Completed

### Phase 1-3: Core Infrastructure & Text Management
- **Authentication**: JWT login with PlaidClient integration, protected routes
- **Project Management**: Create/list/delete UD projects with automatic 8-layer setup
- **Document Management**: Create/list/delete documents within projects  
- **Text Editor**: Rich text interface with manual save to Plaid database
- **Tokenization**: Whitespace tokenization creating real Plaid tokens with persistence
- **Token Visualization**: Interactive display with boundaries, IDs, and hover details
- **Real API Integration**: All operations use actual Plaid APIs, no more demo/simulation code

### Technical Foundation
- React 18 + Vite setup with generated PlaidClient (symlinked from `target/clients/`)
- React Router v6 with nested protected routes
- Context-based auth state management  
- Responsive UI with dark mode support
- Error handling with automatic login redirects

## 🚧 What Remains (Phase 4-6)

### **Phase 4: Annotation Interface** (Next Priority)
The core missing piece is the annotation interface for Universal Dependencies columns.

**Components to Build:**
```
src/components/editor/
├── AnnotationEditor.jsx     # Main annotation interface
├── SentenceNavigator.jsx    # Previous/Next sentence controls  
├── AnnotationGrid.jsx       # Tabular editing interface
├── FeatsEditor.jsx          # Key-value morphological features
└── AnnotationEditor.css
```

**Key Requirements:**
1. **Sentence Segmentation**: Parse text into sentences (newline-based initially)
2. **Annotation Grid**: Table showing CoNLL-U columns (ID, FORM, LEMMA, UPOS, XPOS, FEATS, HEAD, DEPREL)
3. **Column Editors**: 
   - LEMMA: Text input (defaults to token form)
   - UPOS/XPOS: Dropdowns or text inputs for POS tags
   - FEATS: Key-value pair interface with add/remove buttons
   - HEAD/DEPREL: Will connect to dependency tree (Phase 5)
4. **Span Layer Integration**: Connect to existing Plaid span layers (Lemma, UPOS, XPOS, Features)
5. **Data Persistence**: Save annotations as spans with proper token relationships

**API Integration Points:**
- Use existing span layers created in project setup
- `client.spans.create(spanLayerId, tokens, value)` for annotations
- Query existing spans when loading sentences
- Update spans when editing annotations

### **Phase 5: Dependency Tree Visualization**
Build the interactive dependency tree interface using D3.js.

**Components to Build:**
```  
src/components/editor/
├── DependencyTree.jsx       # D3.js tree renderer
├── RelationEditor.jsx       # Drag-and-drop relation creation
└── DependencyTree.css
```

**Key Requirements:**
1. **D3.js Integration**: SVG-based tree rendering following [MIDAS reference](https://raw.githubusercontent.com/gucorpling/midas-loop-ui/refs/heads/master/src/ud-tree/ud-tree/components.js)
2. **Interactive Editing**: Click-and-drag interface for creating HEAD relations
3. **Validation**: Cycle detection, single head constraint, ROOT handling
4. **Relation Layer**: Use existing "Relation" layer created in project setup
5. **DEPREL Labels**: Interface for editing dependency relation labels

### **Phase 6: CoNLL-U Import/Export** 
Add file import/export functionality.

**Components to Build:**
```
src/components/conllu/
├── ConlluExporter.jsx       # Generate and download CoNLL-U files
├── ConlluImporter.jsx       # Upload and parse CoNLL-U files  
└── ConlluUtils.js          # Parsing/generation utilities
```

**Key Requirements:**
1. **Export**: Query all layers and generate proper CoNLL-U format
2. **Import**: Parse CoNLL-U and create all Plaid entities atomically
3. **Format Handling**: Sentence metadata, proper column alignment
4. **Error Handling**: Validation and rollback on import failures

## 🔧 Technical Notes for Next Developer

### Project Structure
```
examples/ud_editor/
├── src/
│   ├── components/
│   │   ├── auth/           # Login, protected routes  
│   │   ├── common/         # Layout, navigation
│   │   ├── projects/       # Project CRUD
│   │   ├── documents/      # Document CRUD
│   │   └── editor/         # Text editor + token visualizer
│   ├── contexts/
│   │   └── AuthContext.jsx # Global auth state
│   ├── services/
│   │   ├── plaidClient.js  # Symlinked generated client
│   │   └── auth.js         # Auth service with JWT
│   └── App.jsx             # Main routing
├── PLAN.md                 # Original detailed specification
├── README.md               # Setup and current features
└── HANDOFF.md              # This file
```

### Current App Routes
```
/login                                          # Public login
/projects                                       # Project list
/projects/:projectId/documents                  # Document list  
/projects/:projectId/documents/:documentId/edit # Text editor ✅
/projects/:projectId/documents/:documentId/annotate # TODO: Annotation interface
```

### Plaid Integration Patterns

**Authentication:**
```javascript
const { getClient } = useAuth();
const client = getClient(); // Returns authenticated PlaidClient
```

**Error Handling:**
```javascript
try {
  const result = await client.someApi.method();
} catch (err) {
  if (err.message === 'Not authenticated' || err.status === 401) {
    window.location.href = '/login';
    return;
  }
  // Handle other errors
}
```

**Layer Discovery:**
```javascript
const projectData = await client.projects.get(projectId, true);
const textLayer = projectData.layers?.find(l => l.name === 'Text');
const tokenLayer = projectData.layers?.find(l => l.name === 'Token');
const lemmaLayer = projectData.layers?.find(l => l.name === 'Lemma');
// etc.
```

### UD Layer Hierarchy (Auto-created)
Every UD project has this structure:
```
Project
├── TextLayer: "Text"
└── TokenLayer: "Token"  
    ├── SpanLayer: "Ellipsis Form"    # Empty nodes
    ├── SpanLayer: "Multi-word Tokens" # Contracted forms
    ├── SpanLayer: "Lemma"            # Base forms
    │   └── RelationLayer: "Relation"  # Dependencies
    ├── SpanLayer: "XPOS"             # Language-specific POS
    ├── SpanLayer: "UPOS"             # Universal POS  
    ├── SpanLayer: "Features"         # Morphological features
    ├── SpanLayer: "Head"             # HEAD references
    └── SpanLayer: "Sentence"         # Sentence boundaries
```

### Next Steps Priority
1. **Start with Phase 4**: Build the annotation grid interface
2. **Focus on LEMMA first**: Simplest span annotation to get the pattern right
3. **Add UPOS/XPOS**: Extend the pattern to other simple annotations
4. **Implement FEATS**: More complex key-value interface
5. **Move to Phase 5**: Dependency tree visualization
6. **Finish with Phase 6**: Import/export functionality

### Development Environment
- Plaid server: `java -jar plaid.jar` (port 8085)
- React dev: `npm run dev` (auto-assigned port, usually 5173-5174)
- API proxy: Vite handles `/api` → `localhost:8085` routing
- Authentication: JWT in localStorage, cleared on server restart

### Key Files for Next Phase
- `src/App.jsx`: Add annotation route  
- `src/components/editor/AnnotationEditor.jsx`: Main new component
- Target route: `/projects/:projectId/documents/:documentId/annotate`
- Replace placeholder in current App.jsx routing

The foundation is solid. The next developer should focus on the annotation interface to complete the core UD editing functionality.