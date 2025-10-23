# Plaid Base - Plaid's Annotation Interface

Plaid Base is a React frontend that connects to the Plaid REST API for linguistic annotation tasks.
Note that we are using React (18.3.1) with Mantine (8.1.3) and React Router DOM (7.6.2).

## Plaid Base Setup Process

The Plaid Base setup wizard configures projects with the following layer structure and configurations:

### Project Level
- `project.config.plaid.initialized = true` - Marks project as Plaid Base-configured
- `project.config.plaid.documentMetadata = [{name: "Date"}, {name: "Speakers"}, ...]` - Available document metadata fields

### Text Layer
- `textLayer.config.plaid.primary = true` - Marks as the primary Plaid Base text layer

### Token Layer  
- `tokenLayer.config.plaid.primary = true` - Marks as the primary Plaid Base token layer
- `tokenLayer.config.plaid.orthographies = [{name: "IPA"}, {name: "Custom"}, ...]` - Available orthographies (baseline excluded)
- `tokenLayer.config.plaid.ignoredTokens = {type: "unicodePunctuation", whitelist: [...]}` - Word-level annotation exclusions

### Morpheme Token Layer
- `tokenLayer.config.plaid.morpheme = true` - Marks as the morpheme token layer for sub-word analysis
- Always created during setup to enable morpheme-level annotations
- Morpheme tokens share the same text extent as their parent word tokens but have unique precedence values

### Span Layers
- Created for each annotation field with `spanLayer.config.plaid.scope = "Word"|"Morpheme"|"Sentence"` - Determines annotation scope
- **Word scope**: Applies to primary word tokens (formerly "Token" scope)
- **Morpheme scope**: Applies to morpheme tokens within words
- **Sentence scope**: Applies to sentence-level spans
- A "Sentences" span layer is always created with `spanLayer.config.plaid.scope = "Sentence"` and `spanLayer.config.plaid.primary = true` - Primary sentence segmentation layer

### Vocabulary Layers
- Linked to projects via `client.projects.linkVocab(projectId, vocabId)` - No special config needed

All configurations use the "plaid" namespace to avoid conflicts with other applications.

## Development

* Assume that the user already has the development server running via `npm run dev`. 
  If you want to check for compilation errors, run `npm run build`.
* Run `tree src/` for an overview of the structure.
* Rely on Mantine's built-in components and their hook library wherever applicable.
  As you consider how to implement something, don't be afraid to use your search tools if you suspect that Mantine might provide parts of it.
* There's typically no need for you to try to test your changes. The user will test it himself in the browser.
* See `@../examples/ud_editor/` for complete Plaid client usage examples
* If it's not obvious to you what a certain client function does or returns, do not make assumptions. Instead, investigate whether existing code clarifies it (feel free to grep for `client.bundle.methodName`), or else ask the user. Also, see `@../../target/clients/client.d.ts` for helpful signatures.
* Make sure that you always import icons from individual files: write `import IconLogout from '@tabler/icons-react/dist/esm/icons/IconLogout.mjs';`, not `import { IconLogout } from '@tabler/icons-react';`.


## Document Parser Output

The `documentParser.js` utility transforms raw Plaid API document responses into a flat, render-friendly structure. The parser returns an object with the following shape:

```javascript
{
  // Core document data
  document: {
    id: string,
    name: string,
    project: string,
    version: number,
    mediaUrl: string | null,
    text: {
      id: string,
      body: string,
      // ... other text properties
    },
    metadata: {
      [fieldName]: any  // Only includes fields configured in project.config.plaid.documentMetadata
    }
  },

  // Array of sentence objects with tokens and annotations
  sentences: [{
    id: string,
    text: string,  // this is an ID of a text object, **NOT** a string
    begin: number,
    end: number,
    sentenceToken: object,  // Full sentence token object
    annotations: {
      [layerName]: span | null  // Sentence-level annotations
    },
    tokens: [{
      id: string,
      text: string,  // this is an ID of a text object, **NOT** a string
      begin: number,
      end: number,
      content: string,  // Pre-computed slice of text.body
      metadata: object,  // Full metadata including orthographies
      annotations: {
        [layerName]: span | null  // Word-level annotations
      },
      orthographies: {
        [orthographyName]: string  // e.g., { "IPA": "hɛˈloʊ", "Custom": "hello" }
      },
      vocabItem: {  // Linked vocabulary item (if any)
        id: string,
        form: string,
        metadata: object,
        vocabId: string,
        vocabName: string,
        linkId: string
      } | null,
      morphemes: [{  // Sub-word morpheme tokens (if morpheme layer configured)
        id: string,
        text: string,  // Reference to same text object as parent token
        begin: number,  // Same as parent token begin
        end: number,    // Same as parent token end
        precedence: number,  // Order within parent token
        content: string,     // Raw morpheme content
        metadata: {
          form: string  // Morpheme form (user-editable)
        },
        annotations: {
          [layerName]: span | null  // Morpheme-level annotations
        },
        vocabItem: {  // Linked vocabulary item (if any)
          id: string,
          form: string,
          metadata: object,
          vocabId: string,
          vocabName: string,
          linkId: string
        } | null
      }] | undefined
    }],
    spans: [  // Pre-computed tokens + gaps for rendering
      {
        type: 'token' | 'gap',
        isToken: boolean,
        begin: number,
        end: number,
        text: string,
        // ... token properties if type === 'token'
      }
    ]
  }],

  // Sorted copy of sentences for efficient operations
  sortedSentences: array,

  // Binary search function to find sentence containing a token
  findSentenceForToken: function(token) => sentence | null,

  // Alignment tokens for time-based media
  alignmentTokens: [{
    id: string,
    begin: number,
    end: number,
    metadata: object,  // Contains timing information
    annotations: object
  }],

  // Layer metadata for debugging
  layers: {
    primaryTextLayer: object,
    primaryTokenLayer: object,
    sentenceTokenLayer: object,
    morphemeTokenLayer: object,  // Morpheme token layer (if configured)
    alignmentTokenLayer: object,
    spanLayers: {
      word: array,      // Word-scoped span layers
      morpheme: array,  // Morpheme-scoped span layers  
      sentence: array   // Sentence-scoped span layers
    }
  },

  // O(1) lookup maps for performance
  tokenLookup: Map<tokenId, token>,
  sentenceLookup: Map<sentenceId, sentence>,
  tokenPositionMaps: Map<sentenceId, Map<tokenId, tokenIndex>>,
  sentenceIndexLookup: Map<sentenceId, sentenceIndex>
}
```

### Key Features:
- **Pre-computed values**: Token content, spans (tokens + gaps), orthographies, and morphemes are pre-computed for rendering efficiency
- **Consistent annotation structure**: All annotations use `null` for missing values, making UI rendering predictable
- **Vocabulary integration**: Single-token vocabulary links are included directly on tokens and morphemes
- **Morpheme support**: Morpheme tokens are automatically parsed and attached to their parent word tokens
- **Lookup maps**: Multiple Map structures enable O(1) lookups for common operations
- **Validation**: The parser validates sentence partitioning and warns about data integrity issues
- **Filtered metadata**: Only document metadata fields configured in `project.config.plaid.documentMetadata` are included
- **Three-tier scoping**: Supports Word, Morpheme, and Sentence-level annotations

### Usage:
```javascript
import { parseDocument } from './utils/documentParser.js';

// Basic usage (no metadata filtering)
const parsed = parseDocument(rawDocument, client);

// With metadata filtering (recommended)
const parsed = parseDocument(rawDocument, client, project);
```

## Field Management and Annotation Scopes

Plaid Base uses a three-tier annotation scope system to organize linguistic analysis at different levels:

### Annotation Scopes
- **Word Scope** (formerly "Token"): Annotations applied to individual word tokens
- **Morpheme Scope**: Annotations applied to sub-word morpheme units
- **Sentence Scope**: Annotations applied to entire sentences or phrases

### Scope Configuration
Each annotation field is configured with one of these scopes during project setup:
- Word-scoped fields create span layers under the primary token layer
- Morpheme-scoped fields create span layers under the morpheme token layer  
- Sentence-scoped fields create span layers under the sentence token layer

### Ignored Tokens (Word Scope Only)
The ignored tokens configuration applies only to Word-scoped annotations:
- **Unicode Punctuation**: Automatically ignore punctuation marks (with optional whitelist)
- **Custom Token List**: Specify exact tokens to ignore for annotation
- Morpheme and Sentence scopes are not affected by ignored token settings

### Visual Distinction
The interface uses color-coded badges to distinguish annotation scopes:
- **Blue**: Word scope annotations
- **Violet**: Morpheme scope annotations  
- **Green**: Sentence scope annotations

## MorphemeGrid Component

The `MorphemeGrid.jsx` component provides morpheme-level annotation capabilities within the DocumentAnalyze interface. It renders when morpheme fields are configured in the project setup.

### Key Features:
- **Morpheme Splitting**: Users can split morphemes by typing "-" at any cursor position in a morpheme form field
- **Morpheme Merging**: Backspace at the beginning of a morpheme merges it with the previous morpheme
- **Vocabulary Linking**: Each morpheme can be linked to vocabulary items via popover interface
- **Optimistic Updates**: All morpheme operations update the UI immediately for responsive interaction
- **Batch Operations**: Multiple morpheme creation uses batched API calls for efficiency
- **Tab Navigation**: Follows consistent tab order through morpheme rows and columns

### Morpheme Data Structure:
```javascript
morpheme: {
  id: string,           // Morpheme token ID
  text: string,         // Reference to text object ID
  begin: number,        // Character start position
  end: number,          // Character end position  
  precedence: number,   // Order within parent word token
  content: string,      // Raw morpheme text content
  metadata: {
    form: string        // Morpheme form (editable)
  },
  annotations: {
    [fieldName]: { value: string } | null  // Morpheme-scoped annotations
  },
  vocabItem: {          // Linked vocabulary item (if any)
    id: string,
    form: string,
    metadata: object,
    vocabId: string,
    vocabName: string,
    linkId: string
  } | null
}
```

### Operations Supported:
- `createMorpheme(wordToken, precedence, form)` - Create new morpheme
- `splitMorpheme(morpheme, leftForm, rightForm)` - Split at cursor position
- `deleteMorpheme(morpheme)` - Delete morpheme (except first one)
- `mergeMorphemes(currentIndex, currentText)` - Merge with previous morpheme
- `updateMorphemeForm(morpheme, form)` - Update morpheme form
- `updateMorphemeSpan(morpheme, field, value)` - Update morpheme annotation

## Enhanced Operations

The system provides comprehensive operations for managing multi-level linguistic annotations:

### Token Operations (Word Level)
- **Split Token**: Divides word tokens at cursor position, automatically deleting coincident morphemes
- **Merge Tokens**: Combines multiple word tokens, deleting associated morpheme tokens
- **Delete Token**: Removes word token and all associated morphemes
- **Bulk Operations**: Supports batch creation/deletion with morpheme cleanup

### Morpheme Operations
- **Create Morpheme**: Add new morpheme to existing word token with specified precedence
- **Split Morpheme**: Divide morpheme at cursor position using "-" key, creating new morpheme
- **Merge Morphemes**: Backspace at morpheme start merges with previous morpheme
- **Delete Morpheme**: Remove morpheme (except first one) and adjust precedences
- **Update Form**: Modify morpheme form with optimistic UI updates
- **Update Annotations**: Apply morpheme-scoped span annotations
- **Reorder**: Automatic precedence management for morpheme sequences

### Vocabulary Operations
- **Link/Unlink**: Associate vocabulary items with tokens or morphemes
- **Batch Linking**: Handle multiple vocabulary operations in single transaction
- **Optimistic Updates**: Immediate UI feedback for vocabulary changes
- **Cross-Reference**: Track vocabulary usage across word and morpheme levels

### Annotation Operations
- **Word Annotations**: Apply to primary word tokens (respects ignored tokens config)
- **Morpheme Annotations**: Apply to individual morphemes within words
- **Sentence Annotations**: Apply to sentence-level spans
- **Orthography Management**: Handle multiple orthographic representations per token

### Data Consistency
- **Optimistic Updates**: All operations update UI immediately for responsive interaction
- **Batch Processing**: Multiple related operations grouped into single API transactions
- **Conflict Resolution**: Temporary ID mapping prevents race conditions during creation
- **Automatic Cleanup**: Morpheme deletion when parent tokens are modified
- **Precedence Management**: Automatic reordering when morphemes are added/removed

## Related Files
- `@../ud_editor/` - Reference implementation with full feature set
- `@../../CLAUDE.md` - Main Plaid platform documentation
- `@../../target/clients/client.js` - API client
- `@../../target/clients/client.d.ts` - TypeScript definitions for API client--useful for seeing function signatures at a glance
