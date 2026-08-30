import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: ['src/**/*.ts'],
            // Excluded on purpose, not out of laziness: these are the layers
            // that ARE the side effect — process wiring and the Baileys socket
            // lifecycle. Everything they call is covered below.
            exclude: [
                // Wiring and the live Baileys socket: these ARE the side
                // effect, and everything they call is covered below.
                'src/main.ts',
                'src/whatsapp/connection.ts',
                'src/cli/setup.ts',
                'src/cli/manage.ts',
                'src/cli/workspaces.ts',
                // Type-only: nothing to execute.
                'src/types.ts',
                'src/core/ports.ts',
            ],
            thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
        },
    },
})
