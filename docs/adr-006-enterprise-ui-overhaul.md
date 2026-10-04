# ADR-006: Enterprise UI Overhaul (Phase 6, v1.1.0)

## Context

Phase 6 was opened for one stated reason: _the functionality is fine, the UI is
not._ That is an accurate summary of the state of affairs at `v1.0.0`. The
interface had been built screen-by-screen to prove that each phase's engine
worked, and never given a design pass. Five screens each defined their own
`<main>` and their own `<nav>`, two near-duplicate status-colour resolvers had
already drifted, and there was no application shell at all.

This ADR records the decisions, and - more importantly - the six defects found
while executing them. Five of the six passed `tsc`, ESLint, the full unit suite
and a clean production build, and were only visible in a browser. That is the
through-line worth keeping.

## Scope decision

**Phase 6 changed no server behaviour.** No endpoint, schema, permission or
business rule changed. Every check that proved the API still behaves correctly

- 317 unit tests, 251 HTTP smoke checks, `db:check` - still passes unchanged.

That constraint is what makes the UI work safe to review, and it was honoured
except where noted in D4.

---

## D1 - shadcn/ui is adopted properly, not nominally

`v1.0.0` had no `components.json` and no registry-managed components. The five
files in `components/ui/` were hand-written and merely _shaped_ like shadcn.

Phase 6 initialises shadcn for real (`components.json`, style `base-nova`) and
adds the components the shell needs: `sidebar`, `collapsible`, `tooltip`,
`dropdown-menu`, `avatar`, `breadcrumb`, `card`, `input`, `label`, `alert`,
`table`, `badge`, `dialog`, `sheet`, `alert-dialog`, `toast`, `field`,
`skeleton`, `separator`, `pagination`, `tabs`, `select`, `scroll-area`, `empty`,
`spinner`.

Two consequences are permanent and must be respected by future work:

**The base is Base UI, not Radix.** Components take a `render` prop
(`<Button render={<Link/>}/>`), not Radix's `asChild`. This is not
interchangeable, and `asChild` is a type error rather than a silent failure.

**`components/ui/` is vendor-owned.** `shadcn add --overwrite` replaces those
files wholesale. Anything OpenERP adds must live outside it, or the next update
deletes it. `NumericCell` therefore lives in `components/data-table/`, and the
lifecycle colour map in `lib/lifecycle-status.ts`.

## D2 - The toast is Base UI's, not Sonner

The brief asked for shadcn `Toast` (Sonner). shadcn's own guidance is that the
toast follows the project base, and this project is `base-nova` = Base UI. Mixing
Sonner with Base UI primitives produces two competing design systems on one
screen, so the Base UI toast (`toast.add({ title, type })`) is used instead.

The vocabulary differs and the migration reflects it: shadcn's `type` is
`success | info | warning | error | loading`, where the old hand-rolled toast
used `variant: 'default' | 'success' | 'destructive'`. `destructive` maps to
`error`.

## D3 - `/` is a router, decided in middleware

`/` never renders. `src/middleware.ts` answers it with a real **302**, before any
React runs, because a client-side redirect paints the wrong screen first.

The middleware reads only whether the session cookie is _present_. That is a
routing decision, not an authorisation one, and the distinction is load-bearing:
the cookie is HTTP-only, so no script can read its contents, and a forged or
expired cookie passes this gate and is then rejected by the API, which is where
authentication actually happens. **Authorisation must never move into this
file.**

The matcher is an explicit allow-list rather than a blanket regex. A stray match
would apply the auth guard to asset requests and turn a missing stylesheet into a
redirect to `/login`.

## D4 - Crew Assignments was specified but not built

The brief lists _Crew Assignments_ under Operations. It was **omitted**, because
neither half of it exists:

- `job.assign` is defined in the permission catalogue and enforced by **no server
  route** - `grep` for it returns nothing outside `shared/src/rbac.ts`.
- There is no assignment endpoint and no crew screen.

Shipping a sidebar link to a non-existent page would be a broken promise, and
building the endpoint is backend work that Phase 6 explicitly excludes (D-Scope).
Delivering it properly needs: an assignment endpoint, enforcement of
`job.assign`, and a screen. Recommended as a Phase 7 item.

Every _other_ nav entry points at a screen that exists.

## D5 - Tab state moved into the URL

`/commercial`, `/operations` and `/admin` each kept their active tab in
`useState`. That made every tab unreachable by link, reset on refresh, and
impossible to cite in a message ("look at tab 3").

State moved to query parameters through `useUrlParam`, which validates the value
against a whitelist. The value arrives from a query string, so it is
attacker-controlled; whitelisting means an unrecognised value falls back instead
of reaching typed code that assumes it is one of a known set - the same reason the
API validates enums rather than trusting them.

This is what makes `Valuation Packs (Ready for Signature)` a real destination:
it deep-links to the jobs board pre-filtered to `07. Pack Ready`, an existing
filter, rather than inventing a screen.

Two consequences worth knowing:

- `router.replace`, not `push`. Tab switching is not navigation; pushing would
  make Back walk through every tab the user clicked.
- Every page using it needs a `Suspense` boundary, because `useSearchParams` opts
  a client component out of static prerendering. The boundaries are declared once
  in `(app)/layout.tsx` and twice more inside `AppShell`, and the build fails
  without them.

## D6 - Access control in the sidebar mirrors, never replaces, the API

`visibleSections()` filters the tree by permission and drops any section whose
children are all hidden - so a field supervisor does not see an empty "Billing &
Finance" heading. An empty result is meaningful and renders an explicit state
rather than a bare frame.

Verified in-browser: a Site Supervisor sees only `Dashboard`, `Valuation Packs`
and `Field Measurements & Actuals`. Commercial and Administration are absent
entirely. An Administrator sees all four sections and all thirteen entries.

Worth flagging: a Site Supervisor sees _Valuation Packs_ but not _Jobs Board_,
because the catalogue grants `job.transition.pack` but withholds `job.read` in
favour of `job.read.assigned`. That is faithful to the RBAC table and was not
changed here, but it is unintuitive enough to warrant a look.

---

## Defects found

Each of these passed `tsc`, ESLint, the full unit suite **and** a clean
production build.

### F1 - `hsl(var(--oklch(...)))` silently voided the entire stylesheet

`shadcn init` rewrote `globals.css` with OKLCH colour tokens
(`--background: oklch(1 0 0)`) while `tailwind.config.ts` still mapped them as
`hsl(var(--background))` - a form that assumes the token holds bare HSL
_channels_.

`hsl(oklch(1 0 0))` is invalid CSS. The browser discards it without a warning,
so `bg-background`, `text-foreground`, `border-border` and every other semantic
utility compiled and computed to nothing. The app rendered as unstyled HTML.

`shadcn init` also added two v4-style `@import` lines, which Tailwind v3 passes
through to the browser as bare specifiers it cannot fetch.

**Resolution: the client moved to Tailwind v4.** Not chosen for currency - chosen
because the `base-nova` components are _authored_ against v4 and use syntax v3
cannot compile: `gap-(--card-spacing)`, `[--card-spacing:--spacing(4)]`,
`rounded-4xl`, `outline-hidden`, and the trailing `!` important suffix. Under v3
`Card` renders with **zero padding** while every check passes. Retrofitting ~30
generated components to v3 was not viable, since every `shadcn add --overwrite`
would reintroduce it.

v4 is CSS-first, so `tailwind.config.ts` is deleted and its colour and radius
maps moved into `@theme inline` in `globals.css`. `inline` is required: without it
v4 emits `--color-background: var(--background)` into `:root`, which is a
self-reference cycle.

Two related self-references were removed at the same time - `shadcn init`'s
`.theme { --font-sans: var(--font-sans) }` block, and the same collision between
`next/font`'s variable and the theme entry. The font variable is now
`--font-geist`.

### F2 - Registry files were failing lint on upstream code

`shadcn add` introduced an `eqeqeq` violation and a `set-state-in-effect`
violation in generated files. `eslint.config.js` now ignores
`client/src/components/ui/**` and `use-mobile.ts`, and OpenERP's own
design-system additions were moved out of that directory so they stay linted.

### F3 - `ui/select.tsx` has no root export

The generated wrapper exports `SelectGroup`, `SelectValue`, `SelectTrigger`,
`SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator` - but **no root
`Select`**. Adopting it would mean importing Base UI's root directly and
hand-assembling the parts.

The one status filter therefore uses a native `<select>`, which is fully
keyboard- and screen-reader-accessible on its own. Deliberate, documented at the
call site, and cheaper than a half-adopted component.

### F4 - `react-hooks/incompatible-library` is a false positive for TanStack Table

`useReactTable()` is documented to return a fresh, non-memoisable object each
render, so the rule's premise does not hold for it. Disabled for the client.

### F5 - Radius scale

The generated components assume the v4 radius scale. `--radius-sm/md/lg/xl` is
declared in `@theme` so `rounded-md` and `rounded-lg` land where v4 puts them.

### F6 - `useSyncExternalStore` requires a _cached_ snapshot

The shell reads two persisted values - the sidebar cookie and the collapsed
section list - via `useSyncExternalStore`, chosen over
`useEffect(() => setState(read()))` because the latter cascades an extra render
on every mount and lets the rail visibly snap into place after first paint.

The first implementation returned `[]` literals from the snapshot function.
React compares snapshots by identity, so a fresh array is indistinguishable from
a changed store: the app crashed with _Maximum update depth exceeded_ and the
whole tree went down. Both the no-storage path and the `getServerSnapshot` now
return a shared frozen constant, and the parsed value is cached by content.

This is the one defect in the phase that the React 19 dev build surfaced loudly;
the other five were silent.

---

## Accessibility and design notes

Applied while building, not deferred:

- One `<main>` landmark. The shell owns it; the five pages were rewritten from
  `<main>` to `<div>`, because nesting them produced two main landmarks.
- Section headers in the sidebar are real `<button>` elements with
  `aria-expanded`. shadcn's `SidebarGroupLabel` renders a `div`, so the
  `CollapsibleTrigger` carries the label's styling itself rather than being
  styled into one.
- Every register table has a `<caption>` and `scope="col"` headers.
- Login errors use `role="alert"` (assertive). A colour change alone conveys
  nothing to a screen-reader user, and that is the one message on the page that
  must interrupt.
- Currency figures use `tabular-nums`, not `font-mono`; a monospaced face renders
  the space in `R 35,64` at full character width, making one amount read as two
  tokens.
- Unbreakable contract references are truncated with the full value on `title`,
  so the expiry date - the reason the row exists - stays on screen instead of
  being pushed out by a sideways scroll.
- `next` on the login page is validated against same-origin absolute paths.
  `//evil.test` is a protocol-relative URL, and an unvalidated redirect parameter
  is an open redirect that survives link scanners.

## Known gaps after v1.1.0

1. **Crew Assignments** - see D4. Needs backend work.
2. **No light/dark toggle.** The `.dark` token set and `@custom-variant dark`
   are in place; no control switches them, so dark mode is currently unreachable.
3. **Dashboard N+1.** Planned-vs-actual variance is only exposed per project, so
   the dashboard fans out with `useQueries`. Fine at this scale; a large
   portfolio needs a server-side roll-up endpoint, which is not a client fix.
4. **`shadcn/tailwind.css` and `tw-animate-css`** are declared as dependencies.
   Only `tw-animate-css` is imported. The former is unused and could be dropped.
5. **Demo accounts still share one password** (`Ops#Field2026x`). Unchanged from
   earlier phases; rotate before any shared use.

---

# Addendum: post-`v1.1.0` fixes and the theming system

Two items landed after `v1.1.0` was tagged. They are recorded here rather than in
a new ADR because they are the same phase's work, discovered by using the thing.

## F7 - The user menu crashed the page on open

`DropdownMenuLabel` in the `base-nova` component set wraps Base UI's
`MenuGroupLabel`, and Base UI throws `MenuGroupContext is missing` unless that
part is inside a menu group. The label was rendered directly inside
`DropdownMenuContent`.

The signature of this defect is why it is worth recording: **the page was
completely healthy until the menu was clicked.** Every automated gate passed,
and the failure only existed on an interaction no test performed. It is the same
class as F1 - invisible to the toolchain, obvious in a browser - which is the
third time in two phases that the browser was the only thing that could find the
bug.

Fix: wrap the label in `DropdownMenuGroup`, which is required rather than
decorative. Documented at the call site so the next person does not "simplify" it
away.

## D7 - Colour is a theme, not a constant

The complaint at `v1.1.0` was blunt: _the application uses no colour._ The cause
was not an absence of palette but the opposite - `--primary` was
`oklch(0.205 0 0)`, a near-black. Everything derived from it was grey, including
the accent every component draws its emphasis from.

### Five themes

| id         | Label    | Character                                           |
| ---------- | -------- | --------------------------------------------------- |
| `harbour`  | Harbour  | Cool slate neutrals, industrial cyan-blue. Default. |
| `steel`    | Steel    | Cooler and bluer.                                   |
| `ember`    | Ember    | Warm neutrals, amber-orange.                        |
| `verdant`  | Verdant  | Green-tinted neutrals, emerald.                     |
| `midnight` | Midnight | **Dark** surface, violet.                           |

A theme is nothing but a `[data-theme='<id>']` block of custom-property overrides
on `<html>`. Nothing in the application knows which theme is active: switching
one attribute restyles the entire app - sidebar, badges, tables, focus rings -
in a single frame, with no re-render and no flash. That is the whole payoff of
having semantic tokens in the first place, and it is why hardcoded colours are
now a defect rather than a shortcut.

Each theme sets **both** the neutral ramp and the accent, so it is a coherent
surface rather than a tint over fixed grey. The light themes share a lightness
skeleton and differ in hue and chroma; that is what makes them feel like one
product in five colourways.

### D7a - Status colour is separate from `destructive`

`--success`, `--warning`, `--info`, `--positive` and `--negative` were added. A
paid invoice and a "Pack Ready" job are **good news that needs colour**, not
errors; routing them through `destructive` made the app look alarming and trained
the eye to ignore red. Every lifecycle badge and the variance figure now read
from these.

### D7b - Hardcoded colours were removed, not just themed around

Nine files carried literal ramps (`bg-amber-50`, `text-red-700 dark:text-red-400`,
`bg-slate-900`, `bg-cyan-400`). These ignored the palette entirely: under
Midnight they rendered amber panels on a near-black surface, and the variance
figure used a colour correct in only two of the five themes. All were migrated to
tokens, using an alpha of the same token for fills and the solid token for text -
which removes the paired `dark:` branches that had to be hand-synced.

The sign-in brand panel was `bg-slate-900` with a hardcoded cyan gradient. It now
uses `--primary` and a `color-mix` wash of its own foreground, so signing in under
Midnight shows one surface rather than two unrelated darks.

### D7c - The theme is applied before first paint

A synchronous inline script in `<head>` reads `localStorage` and sets
`data-theme` during HTML parsing. A React effect runs after hydration, which is
late enough for the user to see a full frame of the wrong palette on every
navigation. The script is a build-time constant from our own module, cannot
throw, and falls back to the CSS default.

`useSyncExternalStore` then carries the value into React. `getSnapshot` reads the
attribute; `getServerSnapshot` returns a constant. This matters: the first
implementation seeded `useState` from `document.documentElement.dataset.theme`,
which returned `ember` on the client while the server had rendered `harbour` -
a hydration mismatch React cannot patch. `useSyncExternalStore` is built for
exactly this and resolves it deterministically.

Theme changes are announced through an `aria-live="polite"` region. A colour change
is completely invisible to a screen-reader user, so without it the picker would
close and appear to have done nothing.

### D7d - One theme axis, not two

There is no separate light/dark toggle. The five themes include the dark one, so
the choice is single-axis: pick a theme, get the surface it implies. Two
independent axes produce ten combinations, most of which nobody wants, and a
"dark mode" switch that silently does nothing when the theme is Midnight is worse
than no switch at all.

`.dark` is retained purely as a `color-scheme` alias, because the shadcn
components' own `dark:` variants are keyed off that class. It deliberately does
**not** repeat the ~30 Midnight declarations - a second copy of a palette is
guaranteed to drift.

## Verification of the theming

`smoke-phase6.mjs` Gate 7 asserts the theme catalogue and the stylesheet agree,
because they are two views of one list:

- exactly five `[data-theme]` blocks exist, and each named theme is present
- all five declare `--primary`, all five are **distinct**, and all five are
  **chromatic** (chroma >= 0.1). This is the direct regression test for the
  `oklch(0.205 0 0)` near-black that caused "no colour" in the first place
- the five status tokens are present
- Midnight sets `color-scheme: dark`
- the theme bootstrap is inlined in the served HTML

Checked in-browser on all five themes: `--primary`, body, card, sidebar, buttons
and badges all re-resolve; Midnight measures 8:1 on muted text against its
surface.
