#!/bin/bash

# Simplified Documentation Build Script
# Uses AsciiDoctor defaults for styling

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
DOCS_DIR="docs"
BUILD_DIR="docs-build"
TARGET_DIR="target"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_command() {
    if ! command -v "$1" &> /dev/null; then
        print_error "Command '$1' not found. Please install it first."
        exit 1
    fi
}

# Check dependencies
check_dependencies() {
    print_status "Checking dependencies..."
    check_command "clojure"
    check_command "asciidoctor"
    check_command "curl"
    print_success "Dependencies checked"
}

# Clean and setup build directory
setup_build_dir() {
    print_status "Setting up build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"/{api,clients,manual}
    print_success "Build directory ready"
}

# Generate OpenAPI spec
generate_openapi() {
    print_status "Generating OpenAPI specification..."
    
    if curl -s http://localhost:8085/api/v1/openapi.json > /dev/null 2>&1; then
        print_warning "Server already running, using existing instance"
        curl -s http://localhost:8085/api/v1/openapi.json > "$TARGET_DIR/openapi.json"
    else
        print_status "Starting server..."
        SKIP_ACCOUNT_CREATION_PROMPT=true clojure -M:dev -e "(do (require '[user :as u]) (u/start) (Thread/sleep 5000))" &
        SERVER_PID=$!
        
        print_status "Waiting for server to start..."
        timeout 30 bash -c 'until curl -s http://localhost:8085/api/v1/openapi.json > /dev/null 2>&1; do sleep 1; done' || {
            print_error "Server failed to start within 30 seconds"
            kill $SERVER_PID 2>/dev/null || true
            exit 1
        }
        
        curl -s http://localhost:8085/api/v1/openapi.json > "$TARGET_DIR/openapi.json"
        kill $SERVER_PID 2>/dev/null || true
        sleep 2
    fi
    
    print_success "OpenAPI specification generated"
}

# Generate client libraries
generate_clients() {
    print_status "Generating client libraries..."
    mkdir -p "$TARGET_DIR/clients"
    
    clojure -M:gen "$TARGET_DIR/openapi.json" "$TARGET_DIR/clients/client.js" js
    clojure -M:gen "$TARGET_DIR/openapi.json" "$TARGET_DIR/clients/client.py" py
    
    print_success "Client libraries generated"
}

# Generate Swagger UI
generate_swagger_ui() {
    print_status "Generating Swagger UI..."
    mkdir -p "$BUILD_DIR/api/swagger-ui"
    
    cat > "$BUILD_DIR/api/swagger-ui/index.html" << 'EOF'
<!DOCTYPE html>
<html>
<head>
  <title>Plaid API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin:0; background: #fafafa; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: '../../openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>
EOF
    
    print_success "Swagger UI generated"
}

# Compile AsciiDoc files
compile_asciidoc() {
    print_status "Compiling AsciiDoc files..."
    
    # Landing page
    if [[ -f "$DOCS_DIR/landing.adoc" ]]; then
        asciidoctor -o "$BUILD_DIR/index.html" "$DOCS_DIR/landing.adoc"
        print_success "Landing page compiled"
    else
        print_error "Landing page not found: $DOCS_DIR/landing.adoc"
        exit 1
    fi
    
    # Technical manual
    if [[ -f "$DOCS_DIR/book.adoc" ]]; then
        asciidoctor -o "$BUILD_DIR/manual/index.html" "$DOCS_DIR/book.adoc"
        print_success "Technical manual compiled"
    else
        print_error "Technical manual not found: $DOCS_DIR/book.adoc"
        exit 1
    fi
    
    print_success "AsciiDoc compilation completed"
}

# Copy assets
copy_assets() {
    print_status "Copying assets..."
    cp "$TARGET_DIR/openapi.json" "$BUILD_DIR/"
    print_success "Assets copied"
}

# Validate build
validate_build() {
    print_status "Validating build..."
    
    required_files=(
        "$BUILD_DIR/index.html"
        "$BUILD_DIR/manual/index.html"
        "$BUILD_DIR/api/swagger-ui/index.html"
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
    print_status "Starting simplified documentation build..."
    
    mkdir -p "$TARGET_DIR"
    
    check_dependencies
    setup_build_dir
    generate_openapi
    generate_clients
    generate_swagger_ui
    compile_asciidoc
    copy_assets
    validate_build
    
    print_success "Documentation build completed successfully!"
    print_status "Output directory: $BUILD_DIR"
    print_status "To serve locally: python -m http.server 8000 -d $BUILD_DIR"
}

main "$@"