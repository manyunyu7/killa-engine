# Testing

```bash
npm test           # vitest, ~0.7s
npm run typecheck  # tsc --noEmit
npm run coverage   # tests + coverage table, fails under threshold
npm run check      # typecheck + coverage — what CI should run
```

172 tests, 100% line coverage of everything except the two files that are pure wiring.

## What is tested, and why that is the interesting part

The engine's risk isn't in the Baileys handshake — that code is inherited and battle-tested. It's in the small decisions: *is this sender an owner, is this session too old to resume, does "in 1 hari" mean a day or an hour, should this reminder still fire after the server was down all night.* Those all live in `src/core` and `src/store`, and none of them touch the network.

So the suite has no mocking framework wrapped around real modules. Instead the code takes its world as parameters:

| Real thing | In tests |
|---|---|
| Baileys socket | `fakeChat()` — records texts, images, presence |
| `claude` CLI | injected `spawn` returning an `EventEmitter` |
| JSON files on disk | `memFile()` — same interface, no fs |
| `Date.now()` | injected `now()`, so an outage is `at(NOW + 24h)` |

`tests/helpers.ts` holds all four. A test that asserts "a reminder missed by 7 hours is skipped" runs in microseconds and has no timers.

## Excluded from coverage, deliberately

`src/main.ts` and `src/whatsapp/connection.ts`. Both are wiring — the socket lifecycle, the reconnect timer, the process wiring — and everything they call is covered. Testing them would mean asserting that the mocks were called, which proves nothing. The CLI entry points (`cli/setup.ts`, `cli/manage.ts`) are excluded for the same reason; their logic lives in `cli/workspace.ts` and `cli/env-file.ts`, which are covered.

## Conventions

- Test names state the behavior and, where it isn't obvious, the reason: *"returns null when the number cannot be known — never a guess"*.
- One assertion subject per test; `it.each` for table cases.
- Timezone is pinned (`process.env.TZ = 'Asia/Jakarta'`) in any suite touching schedules. A schedule test that passes only in your zone is worse than no test.
