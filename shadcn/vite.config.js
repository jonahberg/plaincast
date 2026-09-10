import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The app imports the canonical data modules from ../docs/js (glossary,
// offices, abbreviations, timeline) — single source of truth, so allow the
// dev server to reach one level above this package root.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
            '@data': path.resolve(import.meta.dirname, '../docs/js'),
        },
    },
    server: {
        fs: { allow: ['..'] },
    },
});
