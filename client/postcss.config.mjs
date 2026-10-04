/**
 * Tailwind v4 PostCSS configuration.
 *
 * v4 ships its own PostCSS plugin and bundles autoprefixing, so the previous
 * `tailwindcss` + `autoprefixer` pair is replaced rather than supplemented.
 * There is no `tailwind.config.js` any more - v4 is configured from CSS.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
