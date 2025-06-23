# UD Editor - Universal Dependencies Tree Editor

A React-based demo application for editing Universal Dependencies trees using the Plaid linguistic annotation platform.

## Prerequisites

- Node.js 16+ installed
- Plaid server running on port 8085 (default)

## Quick Start

1. Make sure Plaid server is running:
   ```bash
   java -jar plaid.jar
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open http://localhost:5173 in your browser

## Features Implemented (Phase 1-3)

✅ **Authentication**
- JWT-based login screen
- Protected routes with automatic redirection
- Persistent authentication state

✅ **Project Management**
- List all accessible projects
- Create new UD projects with automatic layer setup
- Delete projects with confirmation

✅ **Document Management**
- List documents within a project
- Create new documents
- Delete documents with confirmation
- Navigation breadcrumbs

✅ **Text & Token Management**
- Rich text editor with manual save to Plaid database
- Real Plaid API integration for text persistence
- Whitespace tokenization creating actual Plaid tokens
- Token visualization with boundaries, IDs, and details
- Real token creation/deletion via Plaid API
- Character position tracking with proper indices
- Persistent data across sessions

✅ **Technical Infrastructure**
- Vite + React 18 setup
- Generated PlaidClient integration
- React Router v6 for navigation
- Context-based state management
- Responsive design with dark mode support

## Project Structure

```
src/
├── components/
│   ├── auth/          # Login form, protected routes
│   ├── common/        # Layout, shared components
│   ├── projects/      # Project list and form
│   ├── documents/     # Document list and form
│   └── editor/        # Text editor and token visualizer
├── contexts/          # Auth context
├── services/          # PlaidClient integration
└── App.jsx           # Main app with routing
```

## Next Steps (Phase 4+)

- Annotation grid for UD columns (LEMMA, UPOS, XPOS, FEATS)
- Dependency tree visualization with D3.js
- CoNLL-U import/export functionality
- Enhanced tokenization (empty nodes, multi-word tokens)

## Development Notes

- API calls are proxied through Vite to avoid CORS issues
- The PlaidClient is symlinked from `target/clients/client.js` and imported as a global
- All UD-specific layers are automatically created when making a new project
- **Real Plaid Integration**: All operations now persist to the actual Plaid database
- **Data Persistence**: Text and tokens are saved and will survive server/browser restarts
- If port 5173 is in use, Vite will automatically use the next available port
- **Authentication**: Tokens persist in localStorage but are cleared on dev server restart
- Page refreshes will redirect to login if authentication is lost