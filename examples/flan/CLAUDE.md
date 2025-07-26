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
- `tokenLayer.config.plaid.ignoredTokens = {type: "unicodePunctuation", whitelist: [...]}` - Token-level annotation exclusions

### Span Layers
- Created for each annotation field with `spanLayer.config.plaid.scope = "Token"|"Sentence"` - Determines annotation scope
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
* See `@examples/ud_editor/` for complete Plaid client usage examples
* If it's not obvious to you what a certain client function does or returns, do not make assumptions. Instead, investigate whether existing code clarifies it (feel free to grep for `client.bundle.methodName`), or else ask the user.
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
        [layerName]: span | null  // Token-level annotations
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
      } | null
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
    alignmentTokenLayer: object,
    spanLayers: {
      token: array,     // Token-scoped span layers
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
- **Pre-computed values**: Token content, spans (tokens + gaps), and orthographies are pre-computed for rendering efficiency
- **Consistent annotation structure**: All annotations use `null` for missing values, making UI rendering predictable
- **Vocabulary integration**: Single-token vocabulary links are included directly on tokens
- **Lookup maps**: Multiple Map structures enable O(1) lookups for common operations
- **Validation**: The parser validates sentence partitioning and warns about data integrity issues
- **Filtered metadata**: Only document metadata fields configured in `project.config.plaid.documentMetadata` are included

### Usage:
```javascript
import { parseDocument } from './utils/documentParser.js';

// Basic usage (no metadata filtering)
const parsed = parseDocument(rawDocument, client);

// With metadata filtering (recommended)
const parsed = parseDocument(rawDocument, client, project);
```

## Related Files
- `@../ud_editor/` - Reference implementation with full feature set
- `@../../CLAUDE.md` - Main Plaid platform documentation
- `@../../target/clients/client.js` - API client
- `@../../target/clients/client.d.ts` - TypeScript definitions for API client--useful for seeing function signatures at a glance
