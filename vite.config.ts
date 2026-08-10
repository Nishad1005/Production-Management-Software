/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    // Boots one throwaway Postgres for the whole run and applies every
    // migration to it, so schema and engine tests exercise real SQL.
    globalSetup: ['./tests/globalSetup.ts'],
    // One database, shared. Files run one at a time because parallel
    // transactions inserting the same master rows deadlock on each other —
    // which says nothing about the code under test.
    fileParallelism: false,
    // Postgres needs a moment to come up on a cold cache.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
