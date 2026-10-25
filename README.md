# AppShot

Automated screen capture & page inventory for web applications.

Point it at an application — URL + credentials — and it logs in, walks every
screen, opens the forms, captures full-page screenshots of each meaningful
state, and writes a `PageInventory.md`, a browsable `gallery.html`, and a
`manifest.json`.

It replaces the manual "click through every page and screenshot it" pass that
otherwise costs a day per application and is never repeatable.

**It is read-only by design.** It opens Add and Edit forms but never submits
them, and it blocks `PUT` / `PATCH` / `DELETE` at the network layer — safe to
point at a validated environment.

---

## The UI

```bash
npm run ui:build     # once
npm run ui           # then open http://localhost:4477
```

Enter the application URL, username and password, press **Start capture**. Live
log and progress stream into the browser; the Results tab browses every run's
screenshots grouped by module, with a lightbox and links to the generated
`PageInventory.md`.

**Find screens** logs in and lists the screens found in the app's own navigation
without capturing anything — useful for a first look at an unfamiliar app.

Credentials typed into the UI are used for that run only. They are never written
to disk, never logged, and never saved into a profile.

For development with hot reload: `npm run ui` in one terminal, `npm run ui:dev`
in another, then open the Vite URL (port 5177).

---

## Setup (once)

```bash
cd "D:/GAMP Lifetech Pvt Ltd/Development/Tools/appshot"
npm install
```

Playwright is pinned to **1.61.1** to match the browser build already installed
for the CCMS automation suite. If browsers are missing:

```bash
npx playwright install chromium
```

Then copy `.env.example` to `.env` and put your credentials there. Credentials
live **only** in `.env` — app profiles reference them as `${VAR}` so profiles
are safe to commit.

---

## Capturing an application you already have a profile for

```bash
node bin/appshot.js capture --app ccms
```

Useful flags:

| Flag | Effect |
|---|---|
| `--only <regex>` | Only routes/modules matching the pattern |
| `--limit <n>` | Stop after n routes |
| `--dry-run` | Print the plan, capture nothing |
| `--headed` | Watch the browser work |
| `--out <dir>` | Override the output directory |
| `--no-interactions` | Landing screenshot only, skip the recipes |

```bash
node bin/appshot.js capture --app ccms --only "master-configuration" --headed
node bin/appshot.js capture --app ccms --dry-run
```

---

## Onboarding a new application

```bash
node bin/appshot.js init lims --url http://lims.example.internal
```

Then:

1. Add `LIMS_USER` / `LIMS_PASSWORD` to `.env`.
2. Open `apps/lims.json` and check the **auth** block (see below).
3. Let it find the screens itself:
   ```bash
   node bin/appshot.js discover --app lims --save
   ```
4. Capture:
   ```bash
   node bin/appshot.js capture --app lims
   ```

Discovery expands every collapsible menu group in the app's own sidebar and
harvests the links, keeping the menu hierarchy as the module grouping. It is a
starting point — open the profile afterwards and rename modules, drop noise,
add any screen the nav doesn't link to.

---

## Auth strategies

### `form` — drive the real login screen (default; no API knowledge needed)

```json
"auth": {
  "strategy": "form",
  "form": {
    "loginPath": "/",
    "usernameSelector": "input[name=\"username\"]",
    "passwordSelector": "input[type=\"password\"]",
    "submitSelector": "button[type=\"submit\"]"
  },
  "verify": { "path": "/dashboard" }
}
```

### `api` — call the login endpoint, inject the token (fastest, most reliable)

Required for SPAs that keep auth in `sessionStorage`, which Playwright's
`storageState` does not persist — CCMS is one of these.

```json
"auth": {
  "strategy": "api",
  "api": {
    "endpoint": "/api/authentication/login",
    "body": { "username": "{{username}}", "password": "{{password}}" },
    "sessionStorage": {
      "authToken": "token",
      "userId":    "userMaster.userID",
      "userData":  "userMaster::json"
    }
  },
  "verify": { "path": "/dashboard" }
}
```

`{{username}}` / `{{password}}` are substituted from `credentials`. Storage
values are dot-paths into the login response; append `::json` to store the
whole object as a JSON string. `localStorage` and `cookies` work the same way.

The run aborts if the session doesn't verify, rather than producing eighty
screenshots of a login screen.

---

## What gets captured per screen

The landing state, plus whichever of these apply — driven by role/text
heuristics, so they work on an app the tool has never seen:

| Recipe | Captures |
|---|---|
| `tabs` | Each tab in a tablist, selected |
| `accordions` | All collapsible sections expanded |
| `filters` | The filter / advanced-search panel open |
| `openAdd` | The Add / New / Create form (opened, never submitted) |
| `rowView` | A row's View detail |
| `rowEdit` | A row's Edit form (opened, never saved) |
| `paginate` | Second page of the grid |

`rowView` and `rowEdit` do not insist on the first row. These grids draw every
action on every row and disable the ones the row's status does not allow — an
approved document keeps a greyed Edit pencil — so they scan down the page
(`interactions.maxRowScan`, default 10) for a row where the action is live, and
log which row they settled on. Tailwind writes those states as
`disabled:opacity-50`, a class that is there whether or not the control is
disabled, so the test is the computed style and the `disabled` property, not the
class string.

`rowDeactivate` is the one recipe that presses a control on
`safety.denyClickText`, because the confirmation window behind Deactivate or
Delete is where a manual has to show the reader that a reason and a signature
will be asked for. It is **not** in the default recipe list — an app profile has
to name it, and that decision belongs to whoever is pointing the tool at a
particular environment. While it runs:

- every request that is not a GET is aborted at the network layer, so nothing
  reaches the server even if the screen skips its own confirmation step. What
  was stopped is logged;
- the window is closed with Cancel or Escape, never Confirm, and no password is
  ever typed;
- the screen is reloaded afterwards, discarding any optimistic change the client
  made to its own copy of the row.

`npm test` proves all of that offline, against a fixture grid that disables the
Delete on row 1 and another that deletes on the spot with no confirmation at
all.

Set them globally in `interactions.recipes`, or per route:

```json
{ "module": "Reports", "name": "Audit Trail Report",
  "path": "/report-dashboard/audit-trail-report",
  "recipes": ["filters", "paginate"] }
```

`"recipes": []` captures the landing state only.

---

## Uniform screenshots, and why they aren't stretched or truncated

**Every image is exactly the viewport size you configured.** A screen taller
than the viewport becomes an ordered series of overlapping slices rather than
one tall image:

```
01_Grid.png                 screen fits in one viewport
02_Add_Form_Top.png         taller screen, captured by scrolling
03_Add_Form_Middle.png
04_Add_Form_Bottom.png
```

Four or more slices are numbered `_Top`, `_Middle_2`, `_Middle_3`, `_Bottom`.
The file counter advances per image, so the folder reads in scroll order.

The hard part is that admin SPAs — every app here — are built as
`height:100vh; overflow:hidden` with the real content in a nested scroll
container, so `window.scrollTo` does nothing and `fullPage:true` returns exactly
one viewport, silently truncating the form. AppShot finds the element that
actually scrolls and drives that.

Before each capture it **pre-scrolls** the screen once (to trigger lazy and
virtualised content), **freezes** animations and hides carets so repeat runs are
diff-stable, waits for any `<canvas>` charts to finish drawing, then captures
slice by slice.

An earlier version grew the page instead and captured it as one tall image. That
was dropped for two reasons: the images were unusable as a set (900px next to
5900px), and resizing the scroll containers made Chart.js re-render its
canvases, so every dashboard chart came out blank. Scrolling changes nothing
about the layout, so charts, grids and virtualised rows are captured exactly as
a user sees them.

---

## Safety

This matters — these are GxP-regulated systems.

- `safety.readOnly` (default `true`) makes `safeClick()` refuse any control
  whose accessible name matches `denyClickText` — Save, Submit, Delete,
  Approve, Reject, Confirm, Sign, and friends.
- `safety.blockMethods` (default `PUT, PATCH, DELETE`) aborts those requests at
  the network layer. `POST` is deliberately allowed: enterprise APIs routinely
  use `POST` for list/search reads, and blocking it would empty every grid.
  Add `allowUrlPatterns` for endpoints that must get through (e.g. login).
- The count of blocked requests is reported at the end of every run and
  recorded in `manifest.json`.

If you need a capture run that *does* write, that is a different tool — use the
Playwright suite in `CCMS/automation`.

---

## Output

Runs land inside the tool, one folder per run:

```
output/ccms/2026-09-01_1315/
  00_Login/01_Login_Page/01_Page.png
  01_Dashboard/01_Dashboard/01_Dashboard_Top.png
                            02_Dashboard_Middle.png
                            03_Dashboard_Bottom.png
  02_Master_Setup/01_Equipment_Master/01_Grid.png
                                      02_Add_Form.png
                                      03_View_Record.png
                                      04_Edit_Form.png
                                      05_Grid_Page2.png
  ...
  PageInventory.md      per-module tables: screen, file, notes, fields, actions, columns
  gallery.html          self-contained browsable index of the run
  manifest.json         machine-readable record, for diffing runs
```

Every run opens with the **login screen**, shot before the session is injected —
after authentication the app redirects past the form and it can never be
photographed again. It sits in `00_Login` rather than taking the number 1 so the
rest of the modules keep the folder numbers they had on earlier runs, which is
what lets `descriptions.json` carry over between runs. Turn it off with
`capture.loginScreen: false`; `--only` skips it, `--limit` does not.

Module and screen folder numbers come from the profile's order, not the filtered
subset — so `--only` runs land in the same folders as a full run. Set
`output.timestampRuns: false` to always overwrite a single `latest/` folder
instead of keeping run history.

---

## Making sure screens have data in them

A screenshot of an empty grid or a blank chart documents nothing. Many screens
default to a narrow filter — CCMS's dashboard defaults to *first-of-month →
today*, which on the 1st of a month is a single day and renders every chart
empty.

Give the route `setup` steps to put it into a state worth capturing:

```json
{ "module": "Dashboard", "name": "Dashboard", "path": "/dashboard",
  "landingLabel": "Dashboard",
  "setup": [
    { "action": "click",    "selector": ".main-container button" },
    { "action": "fillDate", "selector": "[role=\"spinbutton\"][aria-label=\"Day\"]",
      "nth": 0, "value": "{{daysAgo:364}}", "format": "DMY" },
    { "action": "click",    "text": "Apply Filter" },
    { "action": "waitStable" }
  ]
}
```

| Action | Purpose |
|---|---|
| `click` | Target with `selector` (+ optional `nth`), `role`+`name`, or `text` |
| `fill` | Ordinary inputs |
| `fillDate` | MUI X segmented date pickers, where `fill()` silently no-ops — types digits in the field's `format` order (`DMY`, `MDY`, `YMD`) |
| `select` | `<select>` elements |
| `wait` / `waitStable` | Fixed pause / wait for the page to settle |

Values support `{{today}}`, `{{daysAgo:N}}` and `{{monthsAgo:N}}`, resolved at
run time so a profile never goes stale. Setup clicks still go through the
read-only guard.

`PageInventory.md` includes, per screen, the field list (required fields
marked `*`), the action buttons, the grid columns and the tabs — pulled from
the live DOM, which is what makes it useful to a tester rather than just a pile
of images.

---

## Profile reference

```jsonc
{
  "name": "ccms",
  "displayName": "CCMS — Change Control Management System",
  "baseUrl": "${CCMS_BASE_URL}",
  "outputDir": "D:/.../Screenshots-AppShot",   // optional; defaults to output/<name>
  "credentials": { "username": "${CCMS_USER}", "password": "${CCMS_PASSWORD}" },

  "auth":     { /* see above */ },
  "browser":  { "headless": true, "viewport": { "width": 1440, "height": 900 } },
  "capture":  { "loginScreen": true, "settleMs": 900, "maskSelectors": [] },
  "discovery":{ "enabled": true, "excludePatterns": ["logout", "^/$"] },
  "safety":   { "readOnly": true, "blockMethods": ["PUT", "PATCH", "DELETE"] },

  "routes": [
    { "module": "Master Setup",
      "name":   "Equipment Master",
      "slug":   "Equipment_Master",          // folder name; defaults from name
      "path":   "/master-configuration/equipment-master",
      "note":   "shown in PageInventory.md",
      "waitFor": ".MuiTable-root",           // optional gate before capturing
      "recipes": ["openAdd", "rowView"]      // optional per-route override
    }
  ]
}
```

Use `capture.maskSelectors` for anything that changes every run (clocks,
session timers) so screenshots stay diff-stable.

---

## Troubleshooting

**Everything is exactly one viewport tall.** The page genuinely fits, or the
real scroll container was not found. Run `--headed --only <route>` and watch.
If content is cut off, the app nests its scroller unusually — file it and we'll
extend `findScroller` in `src/capture.js`.

**Redirected to a login screen.** The auth mapping is wrong. For `api`, check
the dot-paths against the real login response; a warning naming the missing
path is printed during auth.

**A route captured a spinner.** Raise `stabilize.spinnerTimeout`, or add the
app's spinner class to `stabilize.spinnerSelectors`.

**A recipe misfires.** Every recipe failure is a warning, never fatal — the run
continues. Narrow it per route with `"recipes": [...]`.
