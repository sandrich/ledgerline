## What and why

<!-- What does this change and why? Link the issue: Closes #123 -->

## How to test

<!-- Steps a reviewer can follow, ideally with the demo database (npm run demo:data). -->

## Screenshots

<!-- For UI changes. Use demo data only, never a real portfolio. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass (and `npm run build` for UI or route changes)
- [ ] New migrations are appended, none edited; `lib/db/schema.sql` and test schemas updated
- [ ] `lib/queries/api-types.ts` and all its consumers updated together
- [ ] Every new amount goes through `components/format.ts` (checked with stealth mode on)
- [ ] No secrets, no real wallet addresses, no em or en dashes
- [ ] README / AGENTS.md updated if behaviour, config or commands changed
- [ ] Commit messages follow Conventional Commits
