/**
 * Minimal .env surgery: read one key, replace one line. Deliberately not a
 * parser — the file belongs to the user, so everything we don't understand
 * (comments, spacing, unknown keys) must survive a write untouched.
 */

export function envValue(src: string, key: string): string {
    return src.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
}

export function setEnvValue(src: string, key: string, value: string): string {
    const line = `${key}=${value}`
    return new RegExp(`^${key}=.*$`, 'm').test(src)
        ? src.replace(new RegExp(`^${key}=.*$`, 'm'), line)
        : `${src.replace(/\n*$/, '\n')}${line}\n`
}

/** Digits-only WhatsApp numbers with country code. */
export function normalizeNumbers(input: string[]): { numbers: string[]; invalid: string[] } {
    const raw = input.join(',').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)
    return {
        numbers: raw.filter(n => n.length >= 8 && n.length <= 15),
        invalid: raw.filter(n => n.length < 8 || n.length > 15),
    }
}
