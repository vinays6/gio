import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      '/api/live': {
        target: 'ws://127.0.0.1:5000',
        ws: true,
        changeOrigin: true,
      },
      '/api/lyria': {
        target: 'ws://127.0.0.1:5000',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      '/login': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      '/authorize': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      }
    }
  }
})
