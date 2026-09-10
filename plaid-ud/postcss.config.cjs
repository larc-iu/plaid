// Two presets run side by side for the duration of the Mantine-to-shadcn
// migration: Tailwind (and autoprefixer) for the migrated screens, and
// Mantine's preset for the ones still to come. The Mantine half goes when the
// last Mantine screen does, at the end of Tier 0.
//
// Mantine's preset: rem() conversion, light-dark(), nested selectors, and the
// responsive `@mixin` helpers used in Mantine CSS modules. postcss-simple-vars
// supplies the breakpoint variables those mixins reference.
module.exports = {
  plugins: {
    tailwindcss: {},
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
    autoprefixer: {},
  },
};
