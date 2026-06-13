import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/agent': { target: 'http://localhost:4010', changeOrigin: true },
      '/debug': { target: 'http://localhost:4010', changeOrigin: true },
      '/health': { target: 'http://localhost:4010', changeOrigin: true },
    },
  },
})
