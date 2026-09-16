/**
 * The clock, as the user sees it. Every prompt carries one of these so
 * "tadi", "besok" and "jam 7" mean something to an agent that otherwise has
 * no idea what day it is. Local time = TZ, which config sets to TIMEZONE.
 */

export const stamp = (ts: number): string =>
    new Date(ts).toLocaleString('id-ID', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).replace(/\./g, ':').replace(/, (\d)/, ' $1')

/** Shorter form for transcript lines: no year, no zone. */
export const stampShort = (ts: number): string =>
    new Date(ts).toLocaleString('id-ID', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).replace(/\./g, ':').replace(/, (\d)/, ' $1')
