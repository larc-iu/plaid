import { describe, it, expect } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig.js';

import igtConfig from '../plaid-igt/tailwind.config.js';
import udConfig from '../plaid-ud/tailwind.config.js';
import { PLAID_UI_CONTENT } from './tailwind.preset.js';

// What every app that mounts plaid-ui has to end up with once its Tailwind
// config is resolved. Checked on the RESOLVED config, because that is where the
// one failure this guards against shows up and nothing else does.
//
// `theme.extend` merges across presets; `content` does NOT. Tailwind 3 takes
// the last `content` declared, so a package glob left in the preset is silently
// dropped by any app that lists its own sources, and every class the shared
// components use goes missing from the stylesheet. Nothing errors: the app just
// renders unstyled in the parts it does not own.
//
// This reads BOTH apps, since the preset is shared and either can break it,
// which is why it lives in this package rather than in one of them. It sits
// beside the preset it guards, at the package root, and runs under plaid-igt's
// vitest like every test here.
//
// plaid-dict is deliberately not here: it is a toolchain generation behind and
// still carries its own copy.

const APPS = [
  ['plaid-igt', igtConfig],
  ['plaid-ud', udConfig],
];

describe.each(APPS)('%s tailwind config', (_name, config) => {
  const resolved = resolveConfig(config);

  it("lists the shared package's sources, or its classes never reach the CSS", () => {
    expect(resolved.content.files).toContain(PLAID_UI_CONTENT);
  });

  it('answers to the shadcn token names the shared components use', () => {
    expect(resolved.theme.colors.border).toBe('hsl(var(--border))');
    expect(resolved.theme.colors.muted.foreground).toBe('hsl(var(--muted-foreground))');
    expect(resolved.theme.borderRadius.lg).toBe('var(--radius)');
  });

  it('carries the accordion keyframes, which a shared component animates with', () => {
    expect(resolved.theme.keyframes['accordion-down']).toBeTruthy();
    expect(resolved.theme.animation['accordion-up']).toBeTruthy();
  });

  it('switches theme by class, so the three apps agree on what dark means', () => {
    expect(resolved.darkMode).toEqual(['class']);
  });
});
