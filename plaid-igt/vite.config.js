import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  // Bundled into the uberjar and served under /igt/ (see plaid.server.middleware
  // wrap-bundled-spa), so the production build needs an absolute '/igt/' base for
  // asset URLs. The dev server stays at '/'. The app uses HashRouter, so client
  // routes live in the URL fragment and don't depend on the base path.
  base: command === 'build' ? '/igt/' : '/',
  plugins: [react()],
  resolve: {
    preserveSymlinks: true
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        secure: false
      }
    }
  }
}))
