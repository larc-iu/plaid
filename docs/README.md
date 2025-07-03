# Documentation Pipeline

This directory contains the documentation pipeline for Plaid, which compiles multiple sources into a unified static HTML site.

## Quick Start

### Local Development

1. **Build documentation locally:**
   ```bash
   ./scripts/build-docs.sh
   ```

2. **Serve documentation locally:**
   ```bash
   python -m http.server 8000 -d docs-build
   ```

3. **View documentation:**
   Open http://localhost:8000 in your browser

### Production Deployment

Documentation is automatically built and deployed to GitHub Pages when changes are pushed to the master branch. The workflow:

1. Builds the complete documentation site
2. Pushes the generated content to the `gh-pages` branch
3. GitHub Pages serves the content from the `gh-pages` branch

The workflow is defined in `.github/workflows/docs.yml`.

## Structure

### Source Files

```
docs/
├── landing.adoc          # Landing page (project overview)
├── book.adoc            # Technical manual
├── assets/              # Static assets (images, custom CSS)
└── README.md           # This file
```

### Generated Output

```
docs-build/
├── index.html          # Landing page
├── manual/
│   └── index.html      # Technical manual
├── api/
│   ├── index.html      # API documentation overview
│   └── swagger-ui.html # Interactive API explorer
├── clients/
│   ├── index.html      # Client libraries overview
│   ├── javascript/     # JavaScript client docs
│   └── python/         # Python client docs
├── assets/
│   └── style.css       # Unified styling
└── openapi.json        # API specification download
```

## Building Documentation

### Prerequisites

The build script requires several tools to be installed:

**Required:**
- Java 21+ (for Clojure)
- Clojure CLI
- AsciiDoctor
- curl
- jq

**Optional (for enhanced features):**
- Node.js (for swagger-ui-cli)
- Python 3.x (for Python docs)
- Ruby gems: coderay (for syntax highlighting)

### Environment Variables

The build process supports the following environment variables:

- `SKIP_ACCOUNT_CREATION_PROMPT`: Set to `"true"` to skip the interactive account creation prompt when starting the server. This is automatically set in the GitHub Actions workflow and local build script.

### Manual Build Steps

If you need to build documentation manually or debug the process:

1. **Generate OpenAPI specification:**
   ```bash
   # Start server
   clojure -M:dev
   
   # In another terminal
   curl -o target/openapi.json http://localhost:8085/api/v1/openapi.json
   ```

2. **Generate client libraries:**
   ```bash
   clojure -M:gen target/openapi.json target/clients/client.js js
   clojure -M:gen target/openapi.json target/clients/client.py py
   ```

3. **Compile AsciiDoc files:**
   ```bash
   mkdir -p docs-build/{manual,assets}
   
   # Create CSS
   # (See scripts/build-docs.sh for CSS content)
   
   # Compile landing page
   asciidoctor -a stylesheet=assets/style.css -o docs-build/index.html docs/landing.adoc
   
   # Compile technical manual
   asciidoctor -a stylesheet=../assets/style.css -o docs-build/manual/index.html docs/book.adoc
   ```

4. **Generate API documentation:**
   ```bash
   # With swagger-ui-cli (if available)
   swagger-ui-cli -f target/openapi.json -o docs-build/api/
   
   # Or create basic documentation (see scripts/build-docs.sh)
   ```

5. **Generate client documentation:**
   ```bash
   ./scripts/create-client-docs.sh
   ```

## Writing Documentation

### AsciiDoc Guidelines

- Use AsciiDoc syntax for all documentation files
- Include proper metadata in document headers
- Use consistent heading levels (`==`, `===`, etc.)
- Add cross-references between sections with `<<section-id>>`
- Use code blocks with language specification: `[source,clojure]`

### Landing Page (`landing.adoc`)

The landing page should provide:
- Project overview and key features
- Quick start instructions
- Links to detailed documentation
- Getting help information

Update this file when:
- Core features change
- Getting started process changes
- New client libraries are added

### Technical Manual (`book.adoc`)

The technical manual should provide:
- Complete user guide
- Developer documentation
- API usage examples
- Architecture explanations

This file contains the bulk of the documentation and should be kept up to date with code changes.

### Styling

The CSS in `scripts/build-docs.sh` provides:
- Consistent navigation across all pages
- Responsive design for mobile devices
- Professional styling for code blocks and tables
- Custom styling for AsciiDoc elements

## GitHub Actions Workflow

The documentation pipeline runs automatically on:
- Pushes to master/main branch
- Pull requests (build only, no deploy)
- Manual workflow dispatch

### Workflow Steps

1. **Setup Environment:**
   - Install Java, Clojure, Node.js, Python, Ruby
   - Cache dependencies for faster builds

2. **Generate API Content:**
   - Start Plaid server (with account creation prompt skipped)
   - Download OpenAPI specification
   - Generate client libraries

3. **Build Documentation:**
   - Create CSS and static assets
   - Compile AsciiDoc files to HTML
   - Generate API and client documentation with Swagger UI

4. **Deploy to GitHub Pages:**
   - Push generated content to `gh-pages` branch (master/main only)
   - GitHub Pages automatically serves the updated content

### Customizing the Workflow

Edit `.github/workflows/docs.yml` to:
- Change trigger conditions
- Add new build steps
- Modify deployment settings
- Add additional documentation sources

## Troubleshooting

### Common Issues

**Build fails with "Server failed to start":**
- Check that port 8085 is available
- Ensure all dependencies are installed
- Check Clojure configuration

**AsciiDoc compilation warnings:**
- Section level warnings are usually cosmetic
- Missing gems (like coderay) reduce functionality but don't break builds
- CSS path warnings indicate stylesheet location issues

**Missing client documentation:**
- Ensure client generation completed successfully
- Check that OpenAPI spec was generated correctly
- Verify build scripts have execute permissions

### Local Development Tips

1. **Incremental builds:** During development, you can rebuild individual components:
   ```bash
   # Just rebuild AsciiDoc files
   asciidoctor -a stylesheet=assets/style.css -o docs-build/index.html docs/landing.adoc
   
   # Just rebuild CSS
   # Copy CSS section from scripts/build-docs.sh
   ```

2. **Live preview:** Use a file watcher for automatic rebuilds:
   ```bash
   # Install entr for file watching
   find docs -name "*.adoc" | entr -r ./scripts/build-docs.sh
   ```

3. **Skip server startup:** If you're only updating AsciiDoc content, copy an existing `target/openapi.json` to skip server startup during development.

## Contributing

When making changes to the documentation pipeline:

1. Test builds locally before committing
2. Ensure all required files are generated
3. Check that links work correctly
4. Verify responsive design on mobile devices
5. Update this README if you change the pipeline structure

## See Also

- [Technical Manual](book.adoc) - Complete user and developer guide
- [GitHub Actions Workflow](../.github/workflows/docs.yml) - Automated build configuration
- [Build Script](../scripts/build-docs.sh) - Local build automation
- [Client Generation](../scripts/create-client-docs.sh) - Client documentation scripts