#!/usr/bin/env node

const fs = require('fs');
const path = require('path');


// ---- shared rendering helpers -------------------------------------------
// Docstrings/JSDoc are rendered in FULL (every paragraph, code blocks, and
// multi-line parameter descriptions), not just their first line, so the
// generated reference carries everything the source comment says.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Escape, then turn `code` spans and ``rst code`` spans into <code>.
function inlineCode(s) {
  return escapeHtml(s).replace(/``([^`]+)``/g, '<code>$1</code>').replace(/`([^`]+)`/g, '<code>$1</code>');
}
// Render comment lines (comment/docstring syntax already stripped, relative
// indentation kept) as HTML: blank-line-separated paragraphs; a paragraph whose
// lines are all indented, or one following a line ending in "::" (RST literal
// block), renders as <pre>.
function renderDescription(rawLines) {
  const lines = rawLines.map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';
  const base = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  const rel = lines.map((l) => (l.trim() ? l.slice(base) : ''));
  const paras = [];
  let cur = [];
  for (const l of rel) {
    if (!l.trim()) {
      if (cur.length) { paras.push(cur); cur = []; }
    } else {
      cur.push(l);
    }
  }
  if (cur.length) paras.push(cur);
  let html = '';
  let literalNext = false;
  for (const p of paras) {
    const indented = p.every((l) => /^\s{2,}/.test(l));
    if (indented || literalNext) {
      const dedent = Math.min(...p.map((l) => l.match(/^\s*/)[0].length));
      html += `<pre>${escapeHtml(p.map((l) => l.slice(dedent)).join('\n'))}</pre>`;
      literalNext = false;
      continue;
    }
    let text = p.join(' ');
    if (text.endsWith('::')) { text = text.slice(0, -2) + ':'; literalNext = true; }
    html += `<p>${inlineCode(text)}</p>`;
  }
  return html;
}
// JSDoc: the description is everything before the first @tag.
function jsDescription(lines) {
  const out = [];
  for (const l of lines) {
    if (/^\s*@\w+/.test(l)) break;
    out.push(l);
  }
  return renderDescription(out);
}
// JSDoc @param entries, with continuation lines merged into the tag line.
function jsParams(lines) {
  const tags = [];
  for (const l of lines) {
    if (/^\s*@\w+/.test(l)) tags.push(l.trim());
    else if (tags.length && l.trim()) tags[tags.length - 1] += ' ' + l.trim();
  }
  const params = [];
  const re = /^@param\s+\{([^}]+)\}\s+(\[?[\w.\[\]]+\]?)\s*-?\s*(.*)/;
  for (const t of tags) {
    const m = t.match(re);
    if (!m) continue;
    const [, type, name, desc] = m;
    params.push({
      name: name.replace(/[\[\]]/g, ''),
      type,
      optional: name.includes('['),
      description: inlineCode(desc),
    });
  }
  return params;
}

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
    const description = jsDescription(lines);
    const params = jsParams(lines);
    
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
    const description = jsDescription(lines);
    const params = jsParams(lines);
    
    methods.push({ 
      name: methodName, 
      description, 
      params,
      bundle: 'misc',
      isStatic: true
    });
  }
  
  // Look for specific instance methods that should be in misc
  const miscMethods = [
    'enterStrictMode', 'exitStrictMode',
    'beginBatch', 'submitBatch', 'abortBatch', 'isBatchMode', 'batched',
    'beginOperation', 'endOperation', 'withOperation',
  ];

  for (const methodName of miscMethods) {
    // Try multi-line JSDoc first: /** \n * ... \n */
    const multiLineRegex = new RegExp(`\\/\\*\\*\\s*\\n((?:\\s*\\*.*\\n)*?)\\s*\\*\\/\\s*\\n\\s*(?:async\\s+)?${methodName}\\s*\\([^)]*\\)`, 'g');
    // Also try single-line JSDoc: /** ... */
    const singleLineRegex = new RegExp(`\\/\\*\\*\\s*(.+?)\\s*\\*\\/\\s*\\n\\s*(?:async\\s+)?${methodName}\\s*\\([^)]*\\)`, 'g');

    let instanceMatch = multiLineRegex.exec(content);
    let isSingleLine = false;

    if (!instanceMatch) {
      instanceMatch = singleLineRegex.exec(content);
      isSingleLine = true;
    }

    if (instanceMatch) {
      const docContent = instanceMatch[1];

      let description, params = [];
      if (isSingleLine) {
        description = renderDescription([docContent.trim()]);
      } else {
        const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
        description = jsDescription(lines);
        params = jsParams(lines);
      }

      methods.push({
        name: methodName,
        description,
        params,
        bundle: 'misc'
      });
    }
  }
  
  // Look for bundle assignments like this.vocabLinks = { ... };
  // Require at least a newline inside the braces to skip one-liners like `this.x = {};`
  const bundleRegex = /this\.(\w+)\s*=\s*\{(\n[\s\S]*?)\n\s*\};/g;
  let bundleMatch;

  while ((bundleMatch = bundleRegex.exec(content)) !== null) {
    const [, bundleName, bundleContent] = bundleMatch;

    // Look for method assignments within this bundle
    // Matches both old style (methodName: this._method.bind(this)) and new style (methodName: (args) => ...)
    const methodRegex = /\/\*\*\s*\n([\s\S]*?)\*\/\s*\n?\s*(\w+):\s*(?:this\._|\([^)]*\)\s*=>)/g;
    let methodMatch;
    
    while ((methodMatch = methodRegex.exec(bundleContent)) !== null) {
      const [, docContent, methodName] = methodMatch;
      
      const lines = docContent.split('\n').map(line => line.replace(/^\s*\*\s?/, ''));
      const description = jsDescription(lines);
      const params = jsParams(lines);
      
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
    const defMatch = line.match(/^\s*(?:async )?def (\w+)\(([^)]*)\)(?:\s*->\s*[^:]+)?:/);

    if (defMatch) {
      const methodName = defMatch[1];
      const rawParams = defMatch[2];
      
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
            if (lines[k].match(/^class \w+Resource/)) {
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
        // Check for single-line docstring: """Description."""
        const trimmedStart = lines[docstringStart].trim();
        if (trimmedStart.startsWith('"""') && trimmedStart.endsWith('"""') && trimmedStart.length > 6) {
          docstringEnd = docstringStart;
        } else {
          // Find end of multi-line docstring
          for (let j = docstringStart; j < lines.length; j++) {
            if (j > docstringStart && lines[j].trim().endsWith('"""')) {
              docstringEnd = j;
              break;
            }
          }
        }
        
        if (docstringEnd !== -1) {
          // Extract docstring content (relative indentation kept for code blocks)
          const raw = lines.slice(docstringStart, docstringEnd + 1)
            .map(line => line.replace(/^(\s*)"""/, '$1').replace(/"""\s*$/, ''));
          const sectionRe = /^\s*(Args|Arguments|Returns|Raises|Yields|Attributes|Note|Notes|Example|Examples):\s*$/;
          const descLines = [];
          for (const l of raw) {
            if (sectionRe.test(l)) break;
            descLines.push(l);
          }
          const description = renderDescription(descLines);

          // Args: one entry per `name: text` line; deeper-indented lines continue
          // the previous entry.
          const params = [];
          const argsIndex = raw.findIndex(l => /^\s*(Args|Arguments):\s*$/.test(l));
          if (argsIndex !== -1) {
            let argIndent = null;
            for (let k = argsIndex + 1; k < raw.length; k++) {
              const l = raw[k];
              if (!l.trim() || sectionRe.test(l)) break;
              const indent = l.match(/^\s*/)[0].length;
              const m = l.match(/^\s*(\w+)(?:\s*\([^)]*\))?:\s*(.*)$/);
              if (m && (argIndent === null || indent <= argIndent)) {
                argIndent = indent;
                const [, name, desc] = m;
                params.push({ name, type: 'Any', optional: false, description: desc });
              } else if (params.length) {
                params[params.length - 1].description += ' ' + l.trim();
              }
            }
            for (const p of params) {
              p.optional = /optional/i.test(p.description);
              p.description = inlineCode(p.description);
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
              if (lines[k].match(/^class \w+Resource/)) {
                break;
              }
            }
            if (isMainClient) {
              bundleName = 'misc';
            }
          } else {
            // Look backwards to find the class this method belongs to
            for (let k = i - 1; k >= 0; k--) {
              const classMatch = lines[k].match(/^class (\w+?)(?:\(|:)/);
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
      } else {
        // No docstring — extract params from function signature
        const params = [];
        if (rawParams) {
          for (const part of rawParams.split(',')) {
            const trimmed = part.trim();
            if (!trimmed || trimmed === 'self' || trimmed === 'cls') continue;
            // Strip default values, *, ** prefixes, and type annotations
            if (trimmed === '*') continue;
            const cleaned = trimmed.replace(/^\*{1,2}/, '').replace(/\s*[:=].*$/, '');
            if (cleaned) {
              params.push({
                name: cleaned,
                type: 'Any',
                optional: trimmed.includes('=') || trimmed.includes('| None'),
                description: ''
              });
            }
          }
        }

        let bundleName = 'misc';
        if (methodName === '__init__') {
          let isMainClient = false;
          for (let k = i - 1; k >= Math.max(0, i - 50); k--) {
            if (lines[k].match(/^class PlaidClient/)) { isMainClient = true; break; }
            if (lines[k].match(/^class \w+Resource/)) break;
          }
          if (!isMainClient) continue;
        } else {
          for (let k = i - 1; k >= 0; k--) {
            const classMatch = lines[k].match(/^class (\w+?)(?:\(|:)/);
            if (classMatch) {
              const className = classMatch[1];
              if (className.endsWith('Resource')) {
                bundleName = className.replace('Resource', '')
                  .replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
              }
              break;
            }
          }
        }

        methods.push({
          name: methodName,
          description: '',
          params,
          bundle: bundleName,
          decorators: decorators
        });
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

// Format bundle name for display: "vocabLinks" / "vocab_links" -> "Vocab Links"
function formatBundleName(name) {
  if (name === 'misc') return 'Client';
  // Handle both camelCase and snake_case
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Generate HTML for a set of methods
function generateHTML(title, bundles, lang) {
  const bundleKeys = Object.keys(bundles).sort();

  // Move 'misc' to the front for both languages
  if (bundleKeys.includes('misc')) {
    const miscIndex = bundleKeys.indexOf('misc');
    bundleKeys.splice(miscIndex, 1);
    bundleKeys.unshift('misc');
  }

  const toc = bundleKeys.map(bundle =>
    `<a class="nav-link" href="#${bundle}">${formatBundleName(bundle)}</a>`
  ).join('\n');

  const content = bundleKeys.map(bundle => {
    const methods = bundles[bundle];
    const methodsHTML = methods.map(method => {
      const badges = [];
      if (method.isStatic) badges.push('<span class="badge badge-static">static</span>');
      if (method.decorators && method.decorators.length > 0) {
        method.decorators.forEach(d => badges.push(`<span class="badge badge-decorator">@${d}</span>`));
      }
      const badgesHTML = badges.length > 0 ? ` ${badges.join(' ')}` : '';

      // Build a compact signature
      const paramList = method.params.map(p => p.optional ? `[${p.name}]` : p.name).join(', ');
      const prefix = bundle === 'misc' ? '' : `${bundle}.`;
      const sig = `${prefix}${method.name}(${paramList})`;

      const paramsHTML = method.params.length > 0 ?
        `<table class="params">
          <thead><tr><th>Parameter</th><th>Type</th><th>Description</th></tr></thead>
          <tbody>
            ${method.params.map(param =>
              `<tr>
                <td><code>${param.name}</code>${param.optional ? ' <span class="optional">optional</span>' : ''}</td>
                <td><code>${param.type}</code></td>
                <td>${param.description || ''}</td>
              </tr>`
            ).join('\n')}
          </tbody>
        </table>` : '';

      return `
        <div class="method" id="${bundle}-${method.name}">
          <div class="method-sig"><code>${sig}</code>${badgesHTML}</div>
          <div class="method-desc">${method.description}</div>
          ${paramsHTML}
        </div>
      `;
    }).join('\n');

    return `
      <section id="${bundle}">
        <h2>${formatBundleName(bundle)}</h2>
        ${methodsHTML}
      </section>
    `;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    :root {
      --c-bg: #fff;
      --c-sidebar: #f8f9fa;
      --c-border: #e1e4e8;
      --c-text: #24292e;
      --c-text-secondary: #586069;
      --c-accent: #0366d6;
      --c-accent-light: #e8f0fe;
      --c-code-bg: #f3f4f6;
      --c-method-bg: #fff;
      --c-sig: #1a1a2e;
      --sidebar-w: 220px;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    }

    body {
      font-family: var(--font-sans);
      color: var(--c-text);
      background: var(--c-bg);
      margin: 0;
      line-height: 1.5;
      font-size: 15px;
    }

    /* --- Sidebar --- */
    .sidebar {
      position: fixed;
      top: 0; left: 0;
      width: var(--sidebar-w);
      height: 100vh;
      overflow-y: auto;
      background: var(--c-sidebar);
      border-right: 1px solid var(--c-border);
      padding: 20px 0;
      z-index: 10;
    }
    .sidebar-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--c-text-secondary);
      padding: 0 20px 12px;
      border-bottom: 1px solid var(--c-border);
      margin-bottom: 8px;
    }
    .nav-link {
      display: block;
      padding: 5px 20px;
      color: var(--c-text-secondary);
      text-decoration: none;
      font-size: 14px;
      transition: background 0.15s, color 0.15s;
    }
    .nav-link:hover, .nav-link.active {
      color: var(--c-accent);
      background: var(--c-accent-light);
    }
    /* --- Preamble --- */
    .preamble {
      margin-bottom: 32px;
      padding: 20px 24px;
      background: var(--c-sidebar);
      border: 1px solid var(--c-border);
      border-radius: 8px;
    }
    .preamble h2 {
      font-size: 16px;
      margin: 0 0 12px;
      border: none;
      padding: 0;
    }
    .preamble pre {
      margin: 0;
      padding: 16px;
      background: #1e1e2e;
      color: #cdd6f4;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.6;
    }
    .preamble pre code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: inherit;
    }

    /* --- Main --- */
    .main {
      margin-left: var(--sidebar-w);
      max-width: 860px;
      padding: 40px 48px 80px;
    }
    .main h1 {
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 32px;
      color: var(--c-text);
    }
    .main h2 {
      font-size: 20px;
      font-weight: 600;
      margin: 48px 0 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--c-border);
      color: var(--c-text);
    }

    /* --- Method card --- */
    .method {
      margin: 16px 0;
      padding: 16px 20px;
      border: 1px solid var(--c-border);
      border-radius: 8px;
      background: var(--c-method-bg);
    }
    .method-sig {
      font-family: var(--font-mono);
      font-size: 14px;
      color: var(--c-sig);
      font-weight: 600;
      word-break: break-word;
    }
    .method-sig code { background: none; padding: 0; font-weight: 600; }
    .method-desc {
      margin: 6px 0 0;
      color: var(--c-text-secondary);
      font-size: 14px;
    }
    .method-desc:empty { display: none; }
    .method-desc p { margin: 0 0 0.5em 0; }
    .method-desc p:last-child { margin-bottom: 0; }
    .method-desc pre { margin: 0.4em 0 0.6em 0; padding: 0.5em 0.75em; overflow-x: auto; font-size: 0.85em; }

    /* --- Badges --- */
    .badge {
      display: inline-block;
      font-family: var(--font-sans);
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      vertical-align: middle;
      margin-left: 6px;
    }
    .badge-static { background: #ddf4ff; color: #0550ae; }
    .badge-decorator { background: #fff3cd; color: #856404; }

    /* --- Param table --- */
    .params {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 13px;
    }
    .params th {
      text-align: left;
      font-weight: 600;
      padding: 6px 10px;
      background: var(--c-sidebar);
      border-bottom: 1px solid var(--c-border);
      color: var(--c-text-secondary);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .params td {
      padding: 6px 10px;
      border-bottom: 1px solid var(--c-border);
      vertical-align: top;
    }
    .params tr:last-child td { border-bottom: none; }
    .params code {
      font-size: 13px;
      background: var(--c-code-bg);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .optional {
      font-size: 11px;
      color: var(--c-text-secondary);
      font-style: italic;
    }

    /* --- Responsive --- */
    @media (max-width: 768px) {
      .sidebar { display: none; }
      .main { margin-left: 0; padding: 20px; }
    }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="sidebar-title">${title}</div>
    ${toc}
  </nav>
  <div class="main">
    <h1>${title}</h1>
    ${lang === 'js' ? `
    <div class="preamble">
      <h2>Quick Start</h2>
      <pre><code>import PlaidClient from 'plaid-client';

const client = await PlaidClient.login('http://localhost:8085', 'user@example.com', 'password');

// Create a project
const project = await client.projects.create('My Project');

// Create a document
const doc = await client.documents.create(project.id, 'Document 1');

// List a project's documents (paginated; the client returns the full list)
const docs = await client.projects.listDocuments(project.id);

// Batch multiple operations atomically
client.beginBatch();
client.tokens.create(tokenLayerId, textId, 0, 5);
client.tokens.create(tokenLayerId, textId, 6, 11);
const results = await client.submitBatch();</code></pre>
    </div>` : `
    <div class="preamble">
      <h2>Quick Start</h2>
      <pre><code>from plaid_client import PlaidClient

client = PlaidClient.login("http://localhost:8085", "user@example.com", "password")

# Create a project
project = client.projects.create("My Project")

# Create a document
doc = client.documents.create(project["id"], "Document 1")

# List a project's documents
docs = client.projects.list_documents(project["id"])

# Batch multiple operations atomically
client.begin_batch()
client.tokens.create(token_layer_id, text_id, 0, 5)
client.tokens.create(token_layer_id, text_id, 6, 11)
results = client.submit_batch()</code></pre>
    </div>`}
    ${content}
  </div>
  <script>
    // Highlight active sidebar link on scroll
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-link');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          navLinks.forEach(l => l.classList.remove('active'));
          const link = document.querySelector('.nav-link[href="#' + entry.target.id + '"]');
          if (link) link.classList.add('active');
        }
      });
    }, { rootMargin: '-20% 0px -80% 0px' });
    sections.forEach(s => observer.observe(s));
  </script>
</body>
</html>`;
}

// Main execution
function main() {
  const jsClientPath = path.join(__dirname, '..', '..', 'plaid-client-js', 'src', 'index.js');
  const pyClientPath = path.join(__dirname, '..', '..', 'plaid-client-py', 'src', 'plaid_client', 'client.py');
  // In CI the site root is at the repo root; locally it's under plaid-core/
  const repoRoot = path.join(__dirname, '..', '..');
  const outputDir = fs.existsSync(path.join(repoRoot, '_site'))
    ? path.join(repoRoot, '_site')
    : path.join(__dirname, '..', '_site');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Process JavaScript client
  const jsContent = fs.readFileSync(jsClientPath, 'utf8');
  const jsMethods = parseJSDoc(jsContent);
  const jsBundles = groupByBundle(jsMethods, false);
  const jsHTML = generateHTML('JavaScript API', jsBundles, 'js');
  fs.writeFileSync(path.join(outputDir, 'api-js.html'), jsHTML);

  // Process Python client
  const pyContent = fs.readFileSync(pyClientPath, 'utf8');
  const pyMethods = parsePythonDoc(pyContent);
  const pyBundles = groupByBundle(pyMethods, true);
  const pyHTML = generateHTML('Python API', pyBundles, 'py');
  fs.writeFileSync(path.join(outputDir, 'api-py.html'), pyHTML);
  
  console.log('API documentation generated successfully!');
  console.log(`- JavaScript: ${jsMethods.length} methods in ${Object.keys(jsBundles).length} bundles`);
  console.log(`- Python: ${pyMethods.length} methods in ${Object.keys(pyBundles).length} bundles`);
}

if (require.main === module) {
  main();
}