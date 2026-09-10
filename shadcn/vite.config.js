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
    build: {
        rollupOptions: {
            output: {
                // Vendor split: the framework and the component primitives
                // change far less often than the app code, so returning
                // visitors keep them cached across deploys.
                manualChunks: {
                    vendor: [
                        'react',
                        'react-dom',
                        '@radix-ui/react-accordion',
                        '@radix-ui/react-dialog',
                        '@radix-ui/react-progress',
                        '@radix-ui/react-select',
                        '@radix-ui/react-separator',
                        '@radix-ui/react-slot',
                        '@radix-ui/react-tabs',
                        '@radix-ui/react-tooltip',
                    ],
                },
            },
        },
    },
});
