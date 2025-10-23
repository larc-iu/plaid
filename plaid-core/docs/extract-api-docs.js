#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse JavaScript JSDoc comments
function parseJSDoc(content) {
  const methods = [];
  
  // Look for constructor method
  const constructorRegex = /\/\*\*\s*\n((?:\s*\*.*\n)*?)\s*\*\/\s*\n\s*constructor\s*\([^)]*\)/g;
  let constructorMatch = constructorRegex.exec(content);
  
  if (constructorMatch) {
    const [, docContent] = constructorMatch;
    
    // Extract description and parameters
    const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
    const description = lines.find(line => line.trim() && !line.startsWith('@')) || '';
    
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
    
    methods.push({ 
      name: 'constructor', 
      description, 
      params,
      bundle: 'misc' 
    });
  }
  
  // Look for static methods
  const staticRegex = /\/\*\*\s*\n((?:\s*\*.*\n)*?)\s*\*\/\s*\n\s*static\s+(?:async\s+)?(\w+)\s*\([^)]*\)/g;
  let staticMatch;
  
  while ((staticMatch = staticRegex.exec(content)) !== null) {
    const [, docContent, methodName] = staticMatch;
    
    // Extract description and parameters
    const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
    const description = lines.find(line => line.trim() && !line.startsWith('@')) || '';
    
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
    
    methods.push({ 
      name: methodName, 
      description, 
      params,
      bundle: 'misc',
      isStatic: true
    });
  }
  
  // Look for specific instance methods that should be in misc
  const miscMethods = ['enterStrictMode', 'exitStrictMode', 'beginBatch', 'submitBatch', 'abortBatch', 'isBatchMode'];
  
  for (const methodName of miscMethods) {
    const instanceRegex = new RegExp(`\\/\\*\\*\\s*\\n((?:\\s*\\*.*\\n)*?)\\s*\\*\\/\\s*\\n\\s*(?:async\\s+)?${methodName}\\s*\\([^)]*\\)`, 'g');
    let instanceMatch = instanceRegex.exec(content);
    
    if (instanceMatch) {
      const [, docContent] = instanceMatch;
      
      // Extract description and parameters
      const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
      const description = lines.find(line => line.trim() && !line.startsWith('@')) || '';
      
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
      
      methods.push({ 
        name: methodName, 
        description, 
        params,
        bundle: 'misc'
      });
    }
  }
  
  // Look for bundle assignments like this.vocabLinks = {
  const bundleRegex = /this\.(\w+)\s*=\s*\{([\s\S]*?)\n\s*\};/g;
  let bundleMatch;
  
  while ((bundleMatch = bundleRegex.exec(content)) !== null) {
    const [, bundleName, bundleContent] = bundleMatch;
    
    // Look for method assignments within this bundle
    const methodRegex = /\/\*\*\s*\n([\s\S]*?)\*\/\s*\n?\s*(\w+):\s*this\._/g;
    let methodMatch;
    
    while ((methodMatch = methodRegex.exec(bundleContent)) !== null) {
      const [, docContent, methodName] = methodMatch;
      
      // Extract description (first line that's not a param)
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
      
      methods.push({ 
        name: methodName, 
        description, 
        params,
        bundle: bundleName 
      });
    }
  }
  
  return methods;
}

// Parse Python docstrings
function parsePythonDoc(content) {
  const methods = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = line.match(/^\s*(?:async )?def (\w+)\([^)]*\)(?:\s*->\s*[^:]+)?:/);
    
    if (defMatch) {
      const methodName = defMatch[1];
      
      // Skip private methods, but allow main PlaidClient.__init__
      if (methodName.startsWith('_')) {
        // Only allow the main PlaidClient.__init__ method
        if (methodName === '__init__') {
          // Check if this is in the main PlaidClient class (not a resource class)
          let isMainClient = false;
          for (let k = i - 1; k >= Math.max(0, i - 50); k--) {
            if (lines[k].match(/^class PlaidClient:/)) {
              isMainClient = true;
              break;
            }
            if (lines[k].match(/^class \w+Resource:/)) {
              break; // Found a resource class first, not main client
            }
          }
          if (!isMainClient) continue;
        } else {
          continue; // Skip all other private methods
        }
      }
      if (line.includes('async def') || methodName.endsWith('_async')) continue; // Skip async duplicates
      
      // Check for decorators above the method
      let decorators = [];
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const decoratorMatch = lines[j].trim().match(/^@(\w+)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]); // Add to front to maintain order
        } else if (lines[j].trim() && !lines[j].trim().startsWith('#')) {
          break; // Stop if we hit non-decorator, non-comment line
        }
      }
      
      // Look for docstring on the next lines
      let docstringStart = -1;
      let docstringEnd = -1;
      
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].trim().startsWith('"""')) {
          docstringStart = j;
          break;
        }
      }
      
      if (docstringStart !== -1) {
        // Find end of docstring
        for (let j = docstringStart; j < lines.length; j++) {
          if (j > docstringStart && lines[j].trim().endsWith('"""')) {
            docstringEnd = j;
            break;
          }
        }
        
        if (docstringEnd !== -1) {
          // Extract docstring content
          const docLines = lines.slice(docstringStart, docstringEnd + 1)
            .map(line => line.trim())
            .map(line => line.replace(/^"""/, '').replace(/"""$/, ''));
          
          const description = docLines.find(line => line && !line.startsWith('Args:')) || '';
          
          // Extract parameters from Args section
          const params = [];
          const argsIndex = docLines.findIndex(line => line === 'Args:');
          
          if (argsIndex !== -1) {
            for (let k = argsIndex + 1; k < docLines.length; k++) {
              const paramLine = docLines[k];
              if (!paramLine || paramLine.endsWith(':')) break;
              
              const paramMatch = paramLine.match(/^(\w+):\s*(.*)/);
              if (paramMatch) {
                const [, name, desc] = paramMatch;
                params.push({
                  name: name,
                  type: 'Any',
                  optional: desc.includes('Optional'),
                  description: desc
                });
              }
            }
          }
          
          // Try to infer bundle from surrounding class context
          let bundleName = 'misc';
          
          // Special handling for main PlaidClient.__init__
          if (methodName === '__init__') {
            // Check if this is the main PlaidClient class
            let isMainClient = false;
            for (let k = i - 1; k >= Math.max(0, i - 50); k--) {
              if (lines[k].match(/^class PlaidClient:/)) {
                isMainClient = true;
                break;
              }
              if (lines[k].match(/^class \w+Resource:/)) {
                break;
              }
            }
            if (isMainClient) {
              bundleName = 'misc';
            }
          } else {
            // Look backwards to find the class this method belongs to
            for (let k = i - 1; k >= 0; k--) {
              const classMatch = lines[k].match(/^class (\w+):/);
              if (classMatch) {
                const className = classMatch[1];
                if (className.endsWith('Resource')) {
                  // Convert camelCase to snake_case
                  bundleName = className.replace('Resource', '')
                    .replace(/([A-Z])/g, '_$1')
                    .toLowerCase()
                    .replace(/^_/, '');
                }
                break;
              }
            }
          }
          
          methods.push({ 
            name: methodName, 
            description, 
            params,
            bundle: bundleName,
            decorators: decorators
          });
        }
      }
    }
  }
  
  return methods;
}

// Group methods by API bundle
function groupByBundle(methods, isPython = false) {
  const bundles = {};
  
  if (isPython) {
    // For Python, use the bundle info from the method
    methods.forEach(method => {
      const bundleName = method.bundle || 'misc';
      
      // Skip the login bundle since PlaidClient.login is the preferred method
      if (bundleName === 'login') {
        return;
      }
      
      if (!bundles[bundleName]) {
        bundles[bundleName] = [];
      }
      bundles[bundleName].push(method);
    });
  } else {
    // For JavaScript, use the bundle info from the method
    methods.forEach(method => {
      const bundleName = method.bundle || 'misc';
      
      // Skip the login bundle since authentication should use the main client
      if (bundleName === 'login') {
        return;
      }
      
      if (!bundles[bundleName]) {
        bundles[bundleName] = [];
      }
      bundles[bundleName].push(method);
    });
  }
  
  return bundles;
}

// Generate HTML for a set of methods
function generateHTML(title, bundles) {
  const bundleKeys = Object.keys(bundles).sort();
  
  // Move 'misc' to the front for both languages
  if (bundleKeys.includes('misc')) {
    const miscIndex = bundleKeys.indexOf('misc');
    bundleKeys.splice(miscIndex, 1);
    bundleKeys.unshift('misc');
  }
  
  const toc = bundleKeys.map(bundle => 
    `<li><a href="#${bundle}">${bundle}</a></li>`
  ).join('\n');
  
  const content = bundleKeys.map(bundle => {
    const methods = bundles[bundle];
    const methodsHTML = methods.map(method => {
      const decoratorsHTML = method.decorators && method.decorators.length > 0 ?
        `<div class="decorators">
           ${method.decorators.map(decorator => 
             `<span class="decorator">@${decorator}</span>`
           ).join(' ')}
         </div>` : '';
      
      const staticHTML = method.isStatic ? 
        `<div class="decorators">
           <span class="decorator">static</span>
         </div>` : '';
      
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
          ${decoratorsHTML}${staticHTML}
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
    .decorators { margin: 5px 0; }
    .decorator { background: #e8f4fd; color: #0366d6; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; margin-right: 5px; }
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
  const jsBundles = groupByBundle(jsMethods, false);
  const jsHTML = generateHTML('JavaScript API Documentation', jsBundles);
  fs.writeFileSync(path.join(outputDir, 'api-js.html'), jsHTML);
  
  // Process Python client
  const pyContent = fs.readFileSync(path.join(clientsDir, 'client.py'), 'utf8');
  const pyMethods = parsePythonDoc(pyContent);
  const pyBundles = groupByBundle(pyMethods, true);
  const pyHTML = generateHTML('Python API Documentation', pyBundles);
  fs.writeFileSync(path.join(outputDir, 'api-py.html'), pyHTML);
  
  console.log('API documentation generated successfully!');
  console.log(`- JavaScript: ${jsMethods.length} methods in ${Object.keys(jsBundles).length} bundles`);
  console.log(`- Python: ${pyMethods.length} methods in ${Object.keys(pyBundles).length} bundles`);
}

if (require.main === module) {
  main();
}