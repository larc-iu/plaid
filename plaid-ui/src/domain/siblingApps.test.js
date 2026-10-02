// Where the Plaid mark in an app's header leads: the root of the server the
// app is served from, whatever directory that server is under.
import { describe, it, expect } from 'vitest';
import { serverRootPath } from './siblingApps.js';

describe('serverRootPath', () => {
  it('is / for the jar at the root of its host', () => {
    expect(serverRootPath('/igt/', 'https://plaid.example.org/igt/#/projects')).toBe('/');
    expect(serverRootPath('/umr/', 'https://plaid.example.org/umr/')).toBe('/');
  });

  it('is the prefix for a server under one', () => {
    expect(serverRootPath('/plaid/igt/', 'https://example.org/plaid/igt/#/projects/p1')).toBe(
      '/plaid/',
    );
    expect(serverRootPath('/a/b/ud/', 'https://example.org/a/b/ud/')).toBe('/a/b/');
  });

  it('takes a relative base against the page', () => {
    expect(serverRootPath('./', 'https://example.org/plaid/igt/#/projects')).toBe('/plaid/');
    expect(serverRootPath('./', 'https://example.org/igt/index.html')).toBe('/');
  });

  it('is the dev server’s own root, where the app is served at /', () => {
    expect(serverRootPath('/', 'http://localhost:5174/#/projects')).toBe('/');
    expect(serverRootPath(undefined, 'http://localhost:5173/')).toBe('/');
  });

  it('reads a base without its trailing slash as the same directory', () => {
    expect(serverRootPath('/plaid/igt', 'https://example.org/plaid/igt/')).toBe('/plaid/');
  });
});
