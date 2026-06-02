// Mantine's PostCSS preset: enables rem() conversion, light-dark(), nested
// selectors, and the responsive `@mixin` helpers used in Mantine CSS modules.
// postcss-simple-vars supplies the breakpoint variables those mixins reference.
module.exports = {
  plugins: {
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
  },
};
