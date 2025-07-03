#!/bin/bash

# Documentation Build Script
# This script builds the complete documentation site locally

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DOCS_DIR="docs"
BUILD_DIR="docs-build"
TARGET_DIR="target"
SCRIPTS_DIR="scripts"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
check_command() {
    if ! command -v "$1" &> /dev/null; then
        print_error "Command '$1' not found. Please install it first."
        exit 1
    fi
}

# Function to check dependencies
check_dependencies() {
    print_status "Checking dependencies..."
    
    # Check for required commands
    check_command "clojure"
    check_command "asciidoctor"
    check_command "curl"
    check_command "jq"
    
    # Check for optional commands
    if ! command -v "swagger-ui-cli" &> /dev/null; then
        print_warning "swagger-ui-cli not found. Install with: npm install -g swagger-ui-cli"
    fi
    
    print_success "Dependencies checked"
}

# Function to clean build directory
clean_build() {
    print_status "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"/{api,clients,manual,assets}
    print_success "Build directory cleaned"
}

# Function to start server and generate OpenAPI spec
generate_openapi() {
    print_status "Generating OpenAPI specification..."
    
    # Check if server is already running
    if curl -s http://localhost:8085/api/v1/openapi.json > /dev/null 2>&1; then
        print_warning "Server already running, using existing instance"
        curl -s http://localhost:8085/api/v1/openapi.json > "$TARGET_DIR/openapi.json"
    else
        print_status "Starting server to generate OpenAPI spec..."
        
        # Start server in background
        clojure -M:dev -e "(do (require '[user :as u]) (u/start) (Thread/sleep 5000))" &
        SERVER_PID=$!
        
        # Wait for server to start
        print_status "Waiting for server to start..."
        timeout 30 bash -c 'until curl -s http://localhost:8085/api/v1/openapi.json > /dev/null 2>&1; do sleep 1; done' || {
            print_error "Server failed to start within 30 seconds"
            kill $SERVER_PID 2>/dev/null || true
            exit 1
        }
        
        # Download OpenAPI spec
        curl -s http://localhost:8085/api/v1/openapi.json > "$TARGET_DIR/openapi.json"
        
        # Stop server
        kill $SERVER_PID 2>/dev/null || true
        
        print_status "Waiting for server to stop..."
        sleep 2
    fi
    
    print_success "OpenAPI specification generated"
}

# Function to generate client libraries
generate_clients() {
    print_status "Generating client libraries..."
    
    mkdir -p "$TARGET_DIR/clients"
    
    # Generate JavaScript client
    if clojure -M:gen "$TARGET_DIR/openapi.json" "$TARGET_DIR/clients/client.js" js; then
        print_success "JavaScript client generated"
    else
        print_error "Failed to generate JavaScript client"
        exit 1
    fi
    
    # Generate Python client
    if clojure -M:gen "$TARGET_DIR/openapi.json" "$TARGET_DIR/clients/client.py" py; then
        print_success "Python client generated"
    else
        print_error "Failed to generate Python client"
        exit 1
    fi
    
    print_success "Client libraries generated"
}

# Function to build CSS
build_css() {
    print_status "Building CSS..."
    
    cat > "$BUILD_DIR/assets/style.css" << 'EOF'
/* Plaid Documentation Styles */
* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #f8f9fa;
}

/* Navigation */
nav {
    background: #2c3e50;
    padding: 1rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    position: sticky;
    top: 0;
    z-index: 100;
}

nav a {
    color: white;
    text-decoration: none;
    margin-right: 2rem;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    transition: background-color 0.3s;
}

nav a:hover,
nav a.active {
    background: rgba(255,255,255,0.1);
}

/* Container */
.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
}

/* Typography */
h1, h2, h3, h4, h5, h6 {
    color: #2c3e50;
    margin-bottom: 1rem;
    font-weight: 600;
}

h1 {
    font-size: 2.5rem;
    font-weight: 300;
}

h2 {
    font-size: 2rem;
    margin-top: 2rem;
    padding-bottom: 0.5rem;
    border-bottom: 2px solid #e9ecef;
}

h3 {
    font-size: 1.5rem;
    margin-top: 1.5rem;
}

p {
    margin-bottom: 1rem;
}

/* Links */
a {
    color: #3498db;
    text-decoration: none;
}

a:hover {
    color: #2980b9;
    text-decoration: underline;
}

/* Buttons */
.button {
    display: inline-block;
    background: #3498db;
    color: white;
    padding: 0.75rem 1.5rem;
    text-decoration: none;
    border-radius: 4px;
    transition: background-color 0.3s;
    margin-right: 1rem;
    margin-bottom: 1rem;
}

.button:hover {
    background: #2980b9;
    color: white;
    text-decoration: none;
}

.button.secondary {
    background: #95a5a6;
}

.button.secondary:hover {
    background: #7f8c8d;
}

/* Hero section */
.hero {
    text-align: center;
    padding: 4rem 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    margin-bottom: 2rem;
}

.hero h1 {
    color: white;
    font-size: 3rem;
    margin-bottom: 1rem;
}

.hero p {
    font-size: 1.2rem;
    margin-bottom: 2rem;
}

/* Features grid */
.features {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
    margin: 4rem 0;
}

.feature {
    text-align: center;
    padding: 2rem;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.feature h3 {
    color: #2c3e50;
    margin-bottom: 1rem;
}

/* Client grid */
.client-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
    margin-top: 2rem;
}

.client-card {
    background: white;
    padding: 2rem;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.client-card h3 {
    color: #2c3e50;
    margin-bottom: 1rem;
}

.client-card p {
    color: #666;
    margin-bottom: 1.5rem;
}

/* Code blocks */
pre {
    background: #f4f4f4;
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1rem 0;
    border-left: 4px solid #3498db;
}

code {
    font-family: 'SF Mono', Monaco, 'Inconsolata', 'Roboto Mono', Consolas, 'Droid Sans Mono', monospace;
    font-size: 0.9rem;
}

/* Tables */
table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

th, td {
    padding: 1rem;
    text-align: left;
    border-bottom: 1px solid #e9ecef;
}

th {
    background: #f8f9fa;
    font-weight: 600;
    color: #2c3e50;
}

tr:hover {
    background: #f8f9fa;
}

/* Responsive design */
@media (max-width: 768px) {
    .container {
        padding: 1rem;
    }
    
    .hero h1 {
        font-size: 2rem;
    }
    
    .features {
        grid-template-columns: 1fr;
    }
    
    nav a {
        margin-right: 1rem;
        margin-bottom: 0.5rem;
    }
}

/* AsciiDoc specific styles */
.admonitionblock {
    margin: 1rem 0;
    padding: 1rem;
    border-radius: 4px;
    border-left: 4px solid #3498db;
    background: #f8f9fa;
}

.admonitionblock.note {
    border-left-color: #3498db;
}

.admonitionblock.warning {
    border-left-color: #f39c12;
}

.admonitionblock.caution {
    border-left-color: #e74c3c;
}

.admonitionblock.tip {
    border-left-color: #27ae60;
}

.listingblock {
    margin: 1rem 0;
}

.listingblock .content {
    background: #f4f4f4;
    border-radius: 4px;
    padding: 1rem;
    border-left: 4px solid #3498db;
}

#toc {
    background: white;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 2rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

#toc ul {
    list-style: none;
    padding-left: 1rem;
}

#toc a {
    color: #2c3e50;
    text-decoration: none;
    padding: 0.25rem 0;
    display: block;
}

#toc a:hover {
    color: #3498db;
    text-decoration: underline;
}
EOF
    
    print_success "CSS built"
}

# Function to build API documentation
build_api_docs() {
    print_status "Building API documentation..."
    
    if command -v swagger-ui-cli &> /dev/null; then
        swagger-ui-cli -f "$TARGET_DIR/openapi.json" -o "$BUILD_DIR/api/"
        print_success "Interactive API documentation generated"
    else
        print_warning "swagger-ui-cli not found, creating basic API documentation"
    fi
    
    # Create API index page
    cat > "$BUILD_DIR/api/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
    <title>Plaid API Documentation</title>
    <link rel="stylesheet" href="../assets/style.css">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <nav>
        <a href="../index.html">Home</a>
        <a href="../manual/index.html">Manual</a>
        <a href="index.html" class="active">API</a>
        <a href="../clients/index.html">Clients</a>
    </nav>
    <div class="container">
        <h1>Plaid API Documentation</h1>
        <p>Complete API reference for the Plaid linguistic annotation platform.</p>
        
        <h2>Base URL</h2>
        <pre><code>http://localhost:8085/api/v1/</code></pre>
        
        <h2>Authentication</h2>
        <p>All API endpoints require authentication via JWT tokens in the Authorization header:</p>
        <pre><code>Authorization: Bearer &lt;your-token&gt;</code></pre>
        
        <h2>Resources</h2>
        <p>The API provides the following resources:</p>
        <ul>
            <li><strong>Users</strong>: User management and authentication</li>
            <li><strong>Projects</strong>: Project creation and access control</li>
            <li><strong>Documents</strong>: Document management within projects</li>
            <li><strong>Layers</strong>: Layer configuration and management</li>
            <li><strong>Texts</strong>: Text content management</li>
            <li><strong>Tokens</strong>: Token annotation and editing</li>
            <li><strong>Spans</strong>: Span annotation over tokens</li>
            <li><strong>Relations</strong>: Relationships between spans</li>
        </ul>
        
        <h2>Interactive Documentation</h2>
        <p>For interactive API exploration, use the Swagger UI:</p>
        <a href="swagger-ui.html" class="button">Open Interactive API Docs</a>
        
        <h2>OpenAPI Specification</h2>
        <p>Download the complete OpenAPI specification:</p>
        <a href="../openapi.json" class="button secondary">Download OpenAPI JSON</a>
    </div>
</body>
</html>
EOF
    
    print_success "API documentation built"
}

# Function to build client documentation
build_client_docs() {
    print_status "Building client documentation..."
    
    # Create client documentation directory structure
    mkdir -p "$BUILD_DIR/clients"/{javascript,python}
    
    # Run client documentation scripts
    if [[ -f "$SCRIPTS_DIR/build-client-docs.sh" ]]; then
        bash "$SCRIPTS_DIR/build-client-docs.sh"
    else
        print_warning "Client documentation script not found, creating basic documentation"
        
        # Create basic client documentation
        "$SCRIPTS_DIR/create-client-docs.sh"
    fi
    
    print_success "Client documentation built"
}

# Function to build AsciiDoc documentation
build_asciidoc() {
    print_status "Building AsciiDoc documentation..."
    
    # Build landing page
    if [[ -f "$DOCS_DIR/landing.adoc" ]]; then
        asciidoctor -a stylesheet=assets/style.css -o "$BUILD_DIR/index.html" "$DOCS_DIR/landing.adoc"
        print_success "Landing page built"
    else
        print_error "Landing page not found: $DOCS_DIR/landing.adoc"
        exit 1
    fi
    
    # Build technical manual
    if [[ -f "$DOCS_DIR/book.adoc" ]]; then
        asciidoctor -a stylesheet=../assets/style.css -o "$BUILD_DIR/manual/index.html" "$DOCS_DIR/book.adoc"
        print_success "Technical manual built"
    else
        print_error "Technical manual not found: $DOCS_DIR/book.adoc"
        exit 1
    fi
    
    print_success "AsciiDoc documentation built"
}

# Function to copy additional assets
copy_assets() {
    print_status "Copying additional assets..."
    
    # Copy OpenAPI spec for download
    cp "$TARGET_DIR/openapi.json" "$BUILD_DIR/"
    
    # Copy any additional assets from docs directory
    if [[ -d "$DOCS_DIR/assets" ]]; then
        cp -r "$DOCS_DIR/assets/"* "$BUILD_DIR/assets/" 2>/dev/null || true
    fi
    
    print_success "Assets copied"
}

# Function to validate build
validate_build() {
    print_status "Validating build..."
    
    # Check for required files
    required_files=(
        "$BUILD_DIR/index.html"
        "$BUILD_DIR/manual/index.html"
        "$BUILD_DIR/api/index.html"
        "$BUILD_DIR/clients/index.html"
        "$BUILD_DIR/assets/style.css"
        "$BUILD_DIR/openapi.json"
    )
    
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            print_error "Required file missing: $file"
            exit 1
        fi
    done
    
    print_success "Build validation passed"
}

# Main execution
main() {
    print_status "Starting documentation build..."
    
    # Create required directories
    mkdir -p "$TARGET_DIR" "$SCRIPTS_DIR"
    
    # Execute build steps
    check_dependencies
    clean_build
    generate_openapi
    generate_clients
    build_css
    build_api_docs
    build_client_docs
    build_asciidoc
    copy_assets
    validate_build
    
    print_success "Documentation build completed successfully!"
    print_status "Output directory: $BUILD_DIR"
    print_status "To serve locally: python -m http.server 8000 -d $BUILD_DIR"
}

# Run main function
main "$@"