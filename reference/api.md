# HTTP API

The app is a small Node server (`app/server.mjs`) on `127.0.0.1:4590` that the
page in your browser talks to. This is that conversation, for anyone scripting
against it or changing it. `scripts/check-kit-docs.mjs` fails if this list and
the server disagree, so it cannot quietly go stale.

Everything reads and writes the real repository files; git remains the history.
Nothing here writes to a tune file.

## Who may call it

Binding to `127.0.0.1` keeps the network out, but not your browser: any web page
can send a request to localhost. So the server refuses:

- any request whose `Host` is not its own address, which stops DNS rebinding;
- any request with a foreign `Origin`;
- any request that changes something (anything but `GET`) without the header
  **`X-Tuning-Garage: 1`**, which no other site can add without a CORS preflight
  the server never approves.

A script of your own sends that header on every write. Refused requests get
`403` with the reason.

Names that become file names are validated, never trusted: dates must look like
`YYYY-MM-DD`, revisions like `v001`, and every file written is confined to its
folder. A bad value is a `400`, a missing file a `404`.

## Reading

| Endpoint | Returns |
|---|---|
| `GET` `/api/state` | Everything the page shows: vehicles, progression, User Math, platforms, definitions, scanner configs, git status, and `version` |
| `GET` `/api/file` | One repository file by `path`; add `dl=1` to download it |
| `GET` `/api/checklist` | The pre-flash checklist, parsed from `templates/pre-flash-checklist.md` |
| `GET` `/api/preferences` | Display units, and the quantities that can be converted |
| `GET` `/api/timeline` | One vehicle's history and the gaps worth noticing (`vehicle`) |

## Analysis (read-only)

| Endpoint | Returns |
|---|---|
| `GET` `/api/analyze` | Gen III bin analysis: OS ID, segment checksums, VIN (`path`) |
| `GET` `/api/compare` | Two bins compared by region and, with an XDF, by table (`a`, `b`, optional `xdf`) |
| `GET` `/api/xdf` | Tables and constants in a definition (`path`) |
| `GET` `/api/xdf-table` | One table's values read through a definition (`xdf`, `bin`, `id`) |
| `GET` `/api/logsummary` | Per-channel min, average and maximum of a CSV (`path`) |
| `GET` `/api/loganalysis` | The full log analysis: trims, wideband, knock, VE, airflow, event timeline, math channels (`path`, plus filter options) |
| `GET` `/api/logcompare` | Before/after comparison of two logs (`a`, `b`) |
| `GET` `/api/report` | A Markdown report and its file name; `kind` is `log`, `logcompare`, `vehicle`, `bincompare` or `session` |
| `GET` `/api/scanner-file` | One VCM Scanner file, decoded against the channel dictionary (`path`) |
| `GET` `/api/usermath-export` | A User Math entry as a VCM Scanner Math Lab file (`id`) |
| `GET` `/api/submission/file` | The scrubbed log of a prepared submission (`id`) |

## Writing

All of these need the `X-Tuning-Garage` header.

| Endpoint | Does |
|---|---|
| `POST` `/api/upload` | Saves a file into the repository; the body is the raw file and the query says what it is (`kind`, `vehicle`, `name`, `desc`, `date`, `rev`) |
| `POST` `/api/vehicle` | Creates a vehicle folder from the template |
| `POST` `/api/vehicle-field` | Updates one row of a vehicle's profile |
| `POST` `/api/changelog` | Adds a revision's entry to a vehicle's tune changelog |
| `POST` `/api/session` | Writes a session log |
| `POST` `/api/flashed` | Records a flash, only if every pre-flash checklist item is ticked |
| `POST` `/api/relocate` | Moves a misfiled upload into `donor-files/` and logs why |
| `POST` `/api/progression` | Changes a learning-tracker status, note or milestone |
| `POST` `/api/usermath` | Adds, edits or deletes a User Math formula |
| `POST` `/api/scanner-dictionary` | Adds or removes a hand-written channel name |
| `POST` `/api/scanner-import-math` | Imports a scanner Math Lab file into User Math |
| `POST` `/api/preferences` | Changes display units |
| `POST` `/api/report/save` | Saves a report into the vehicle's `reports/` folder |
| `POST` `/api/submission/prepare` | Scrubs a log, packages it outside the repository, and returns the preview |
| `POST` `/api/submission/post` | Posts a prepared submission through the GitHub CLI, only with `confirmed: true` |
| `POST` `/api/git` | `commit-push` or `sync` (a fast-forward pull only) |

## Changing it

Add the route to `app/server.mjs` and a row here in the same change. A route
without a row, or a row without a route, fails `scripts/check-kit-docs.mjs`,
and so fails CI. New writes need a test in `scripts/test/server.test.mjs` that
shows them refused without the header.
