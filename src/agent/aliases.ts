/**
 * Model aliases come from the claude CLI's own --help, so the list tracks
 * whatever this installation actually offers instead of a hardcoded guess
 * that rots with every release.
 */

export const FALLBACK_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']

/** Pull quoted aliases out of the --model section of `claude --help`. */
export function parseAliases(help: string): string[] {
    const section = help.split('--model')[1]?.split('--')[0] ?? ''
    const found = [...section.matchAll(/'([a-z][a-z0-9.-]*)'/g)].map(m => m[1]!)
    return found.length ? [...new Set(found)] : FALLBACK_ALIASES
}

export function discoverAliases(run: () => string): string[] {
    try { return parseAliases(run()) } catch { return FALLBACK_ALIASES }
}
