# Flan - Plaid Annotation Interface

Flan is a React frontend that connects to the Plaid REST API for linguistic annotation tasks.
Note that we are using React (18.3.1) with Mantine (8.1.3) and React Router DOM (7.6.2).

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
