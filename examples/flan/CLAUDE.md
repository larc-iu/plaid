# Flan - Plaid Annotation Interface

Flan is a React frontend that connects to the Plaid REST API for linguistic annotation tasks.
Note that we are using React (18.3.1) with Mantine (8.1.3) and React Router DOM (7.6.2).

## Flan Setup Process

The Flan setup wizard configures projects with the following layer structure and configurations:

### Project Level
- `project.config.flan.initialized = true` - Marks project as Flan-configured
- `project.config.flan.documentMetadata = [{name: "Date"}, {name: "Speakers"}, ...]` - Available document metadata fields

### Text Layer
- `textLayer.config.flan.primary = true` - Marks as the primary Flan text layer

### Token Layer  
- `tokenLayer.config.flan.primary = true` - Marks as the primary Flan token layer
- `tokenLayer.config.flan.orthographies = [{name: "IPA"}, {name: "Custom"}, ...]` - Available orthographies (baseline excluded)
- `tokenLayer.config.flan.ignoredTokens = {type: "unicodePunctuation", whitelist: [...]}` - Token-level annotation exclusions

### Span Layers
- Created for each annotation field with `spanLayer.config.flan.scope = "Token"|"Sentence"` - Determines annotation scope
- A "Sentences" span layer is always created with `spanLayer.config.flan.scope = "Sentence"` and `spanLayer.config.flan.primary = true` - Primary sentence segmentation layer

### Vocabulary Layers
- Linked to projects via `client.projects.linkVocab(projectId, vocabId)` - No special config needed

All configurations use the "flan" namespace to avoid conflicts with other applications.

## Development

* Assume that the user already has the development server running via `npm run dev`. 
  If you want to check for compilation errors, run `npm run build`.
* Run `tree src/` for an overview of the structure.
* Rely on Mantine's built-in components and their hook library wherever applicable.
  As you consider how to implement something, don't be afraid to use your search tools if you suspect that Mantine might provide parts of it.
* There's typically no need for you to try to test your changes. The user will test it himself in the browser.
* See `@examples/ud_editor/` for complete Plaid client usage examples
* If it's not obvious to you what a certain client function does or returns, do not make assumptions. Instead, investigate whether existing code clarifies it (feel free to grep for `client.bundle.methodName`), or else ask the user.

## Related Files

- `@../ud_editor/` - Reference implementation with full feature set
- `@../../CLAUDE.md` - Main Plaid platform documentation
- `@../../target/clients/client.js` - API client
- `@../../target/clients/client.d.ts` - TypeScript definitions for API client--useful for seeing function signatures at a glance
