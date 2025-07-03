#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse JavaScript JSDoc comments
function parseJSDoc(content) {
  const methods = [];
  const jsdocRegex = /\/\*\*\s*\n([\s\S]*?)\*\/\s*\n?\s*(\w+):/g;
  let match;
  
  while ((match = jsdocRegex.exec(content)) !== null) {
    const [, docContent, methodName] = match;
    
    // Extract description (first line)
    const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
    const description = lines.find(line => line.trim() && !line.startsWith('@')) || '';
    
    // Extract parameters
    const params = [];
    const paramRegex = /@param\s+\{([^}]+)\}\s+(\[?[\w\[\]]+\]?)\s*-?\s*(.*)/g;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(docContent)) !== null) {
      const [, type, name, desc] = paramMatch;
      params.push({
        name: name.replace(/[\[\]]/g, ''),
        type: type,
        optional: name.includes('['),
        description: desc
      });
    }
    
    methods.push({ name: methodName, description, params });
  }
  
  return methods;
}

// Parse Python docstrings
function parsePythonDoc(content) {
  const methods = [];
  const methodRegex = /def (\w+)\([^)]*\):[^"]*"""([^"]*(?:"""|$))/g;
  let match;
  
  while ((match = methodRegex.exec(content)) !== null) {
    const [, methodName, docContent] = match;
    
    if (methodName.startsWith('_')) continue; // Skip private methods
    
    const lines = docContent.split('\n').map(line => line.trim());
    const description = lines[0] || '';
    
    // Extract parameters from Args section
    const params = [];
    const argsIndex = lines.findIndex(line => line === 'Args:');
    
    if (argsIndex !== -1) {
      for (let i = argsIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.endsWith(':')) break;
        
        const paramMatch = line.match(/^(\w+):\s*(.*)/);
        if (paramMatch) {
          const [, name, desc] = paramMatch;
          params.push({
            name: name,
            type: 'Any', // Python client uses Any for most types
            optional: desc.includes('Optional'),
            description: desc
          });
        }
      }
    }
    
    methods.push({ name: methodName, description, params });
  }
  
  return methods;
}

// Group methods by API bundle
function groupByBundle(methods) {
  const bundles = {};
  
  // Extract bundle names from the structure
  const bundleNames = [
    'vocabLinks', 'vocabLayers', 'relations', 'spanLayers', 'spans',
    'tokenLayers', 'tokens', 'textLayers', 'texts', 'documents', 
    'projects', 'users', 'audit'
  ];
  
  // For this simple approach, we'll group by common prefixes
  methods.forEach(method => {
    let bundleName = 'misc';
    
    // Try to match method name to bundle
    for (const bundle of bundleNames) {
      if (method.name.toLowerCase().includes(bundle.toLowerCase().replace(/s$/, ''))) {
        bundleName = bundle;
        break;
      }
    }
    
    if (!bundles[bundleName]) {
      bundles[bundleName] = [];
    }
    bundles[bundleName].push(method);
  });
  
  return bundles;
}

// Generate HTML for a set of methods
function generateHTML(title, bundles) {
  const bundleKeys = Object.keys(bundles).sort();
  
  const toc = bundleKeys.map(bundle => 
    `<li><a href="#${bundle}">${bundle}</a></li>`
  ).join('\n');
  
  const content = bundleKeys.map(bundle => {
    const methods = bundles[bundle];
    const methodsHTML = methods.map(method => {
      const paramsHTML = method.params.length > 0 ? 
        `<h4>Parameters</h4>
         <ul>
           ${method.params.map(param => 
             `<li><strong>${param.name}</strong> (${param.type}${param.optional ? ', optional' : ''}) - ${param.description}</li>`
           ).join('\n')}
         </ul>` : '';
      
      return `
        <div class="method">
          <h3><code>${method.name}</code></h3>
          <p>${method.description}</p>
          ${paramsHTML}
        </div>
      `;
    }).join('\n');
    
    return `
      <section id="${bundle}">
        <h2>${bundle}</h2>
        ${methodsHTML}
      </section>
    `;
  }).join('\n');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .toc { background: #f5f5f5; padding: 15px; margin-bottom: 30px; }
    .method { border-bottom: 1px solid #eee; padding: 20px 0; }
    .method:last-child { border-bottom: none; }
    h1 { color: #333; }
    h2 { color: #666; border-bottom: 2px solid #666; padding-bottom: 5px; }
    h3 { color: #888; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; }
    ul { margin: 10px 0; }
    li { margin: 5px 0; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <nav class="toc">
    <h2>Table of Contents</h2>
    <ul>
      ${toc}
    </ul>
  </nav>
  ${content}
</body>
</html>
  `;
}

// Main execution
function main() {
  const clientsDir = path.join(__dirname, '..', 'target', 'clients');
  const outputDir = path.join(__dirname, '..', '_site');
  
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Process JavaScript client
  const jsContent = fs.readFileSync(path.join(clientsDir, 'client.js'), 'utf8');
  const jsMethods = parseJSDoc(jsContent);
  const jsBundles = groupByBundle(jsMethods);
  const jsHTML = generateHTML('JavaScript API Documentation', jsBundles);
  fs.writeFileSync(path.join(outputDir, 'api-js.html'), jsHTML);
  
  // Process Python client
  const pyContent = fs.readFileSync(path.join(clientsDir, 'client.py'), 'utf8');
  const pyMethods = parsePythonDoc(pyContent);
  const pyBundles = groupByBundle(pyMethods);
  const pyHTML = generateHTML('Python API Documentation', pyBundles);
  fs.writeFileSync(path.join(outputDir, 'api-py.html'), pyHTML);
  
  console.log('API documentation generated successfully!');
  console.log(`- JavaScript: ${jsMethods.length} methods`);
  console.log(`- Python: ${pyMethods.length} methods`);
}

if (require.main === module) {
  main();
}