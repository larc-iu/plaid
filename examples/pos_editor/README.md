# POS Editor - Plaid API Demo

A React-based Part-of-Speech (POS) tagging editor that demonstrates the capabilities of the Plaid API for linguistic annotation.

## Features

- **User Authentication**: Login with username/password
- **Project Management**: List and create projects with pre-configured layers
- **Document Management**: Create and manage documents within projects
- **Text Editing**: Edit document content with automatic tokenization
- **Token Management**: View and edit individual tokens
- **Sentence Boundaries**: Mark sentence boundaries with visual indicators
- **POS Tagging**: Assign part-of-speech tags to tokens

## Prerequisites

- Node.js (v16 or higher)
- A running Plaid API server (default: http://localhost:8085)

## Installation

1. Navigate to the project directory:
   ```bash
   cd examples/pos_editor
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```

4. Open your browser to http://localhost:3000

## Usage

### 1. Login
- Enter your Plaid server URL (default: http://localhost:8085)
- Provide your username and password
- Click "Login" to authenticate

### 2. Project Management
- View existing projects or create a new one
- When creating a project, the system automatically sets up:
  - One text layer for primary content
  - One token layer for tokenization
  - Two span layers: one for POS tags, one for sentence boundaries

### 3. Document Management
- Select a project to view its documents
- Create new documents or select existing ones

### 4. Document Editing
- **Text Editing**: Type in the text area to add/modify content
  - Text is automatically tokenized on whitespace
- **Sentence Boundaries**: 
  - Red bars (|) indicate sentence starts
  - Click "Mark Sentence Start" to toggle boundaries
  - The first token having a boundary has no effect
- **POS Tagging**: 
  - Enter POS tags in the input fields next to each token
  - Tags are saved automatically when you finish typing

## Architecture

The application demonstrates key Plaid API concepts:

- **Hierarchical Layers**: Projects → Text Layers → Token Layers → Span Layers
- **Configuration**: Uses `setConfig` to mark span layers for specific purposes
- **Automatic Tokenization**: Creates tokens based on whitespace separation
- **Span Annotations**: Uses spans to represent both POS tags and sentence boundaries

## API Integration

The app uses the generated `PlaidClient.js` to interact with the Plaid API:

- `client.login.create()` - User authentication
- `client.projects.*` - Project CRUD operations
- `client.*Layers.*` - Layer management and configuration
- `client.documents.*` - Document operations
- `client.texts.*` - Text content management
- `client.tokens.*` - Token operations
- `client.spans.*` - Annotation management

## Styling

Uses Tailwind CSS for responsive, clean styling without additional dependencies.