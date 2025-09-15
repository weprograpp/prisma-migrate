# Prisma Migrate GitHub Action

**Action**: `prisma-migrate`  
**Purpose**: Download/cache the Prisma CLI and run `prisma migrate deploy` against one or many databases from other workflows.

This repo contains a reusable GitHub Action (Node / TypeScript) that:

- Downloads & caches the Prisma npm package (so callers *don't* need to `npm i prisma` every time).
- Exposes a small CLI-style action that runs `prisma migrate deploy` for each `DATABASE_URL` you pass (supports single URL, newline/comma separated, or JSON array).
- Lets you point to a custom `schema.prisma` and pass extra `prisma` args.
- Runs migrations sequentially (to avoid DB locks); workflows can parallelize via a matrix if desired.

---

## Features

- ✅ **Single or Multiple Databases**: Support for single database URL or JSON array of URLs
- 🔒 **Secret Masking**: Automatically masks database URLs in logs
- 🚀 **Sequential Execution**: Runs migrations sequentially with built-in concurrency control
- 🔍 **Dry Run Support**: Preview migrations without applying changes
- 📊 **Detailed Summaries**: Generates comprehensive reports via `$GITHUB_STEP_SUMMARY`
- 🛡️ **No Resets**: Designed specifically for `migrate deploy` (no destructive operations)
- ⚙️ **Configurable**: Custom Prisma versions, schema paths, and working directories

---

## Inputs & Outputs

### Inputs

| Input               | Description                                                             | Required | Default                |
|---------------------|-------------------------------------------------------------------------|----------|------------------------|
| `database-url`      | Single database URL or JSON array of database URLs                      | ✅ Yes | -                      |
| `schema`            | Path to Prisma schema file                                              | ❌ No | `prisma/schema.prisma` |
| `prisma-version`    | Prisma version to use                                                   | ❌ No | `5.22.0`               |
| `fail-fast`         | Stop on first failre (and don't apply migrations to any other database) | ❌ No | `true`                 |
| `prisma-args`       | Extra args to pass to `prisma migrate deploy`                           | ❌ No | _empty_                |
| `working-directory` | Working directory to run commands in                                    | ❌ No | `.`                    |

- `prisma-version` — (optional) Prisma CLI version, e.g. `6.16.1` or `latest` (default `latest`).
- `database-urls` — (required) One or more DB URLs. Accepts:
  - JSON array: `["postgres://...","mysql://..."]`
  - Newline or comma-separated list
- `schema` — (optional) path to `schema.prisma` (default: `prisma/schema.prisma`).
- `prisma-args` — (optional) extra args appended to `prisma migrate deploy` (e.g. `--force`).
- `fail-fast` — (optional) `"true"`/`"false"`, stop on first failure. Default: `"true"`.
- `working-directory` — (optional) working dir (default: `.`).

### Outputs
- `results` — JSON array of `{ databaseUrlMasked, ok, exitCode, ms }` for each DB.

---

## Quickstart

1. Add this action to a workflow (see `EXAMPLES.md` for multiple usage patterns).
2. Provide DB URLs as secrets and/or inputs.
3. Optionally cache Prisma engines using `actions/cache` for speed.

Example (short):

```yaml
- name: Run Prisma Migrate
  uses: your-org/action-prisma-migrate@v1
  with:
    prisma-version: "latest"
    schema: "apps/api/prisma/schema.prisma"
    database-urls: |
      ${{ secrets.DATABASE_URL }}
      ${{ secrets.REPLICA_DATABASE_URL }}
    prisma-args: "--telemetry-information=false"
    fail-fast: "true"
````

---

## Security & secrets

* Always pass DB URLs via GitHub Secrets (e.g. `secrets.DATABASE_URL`).
* The action calls `core.setSecret` on each DB URL so it is redacted from logs; **still** treat secrets carefully.
* Avoid printing full URLs or dumping environment in logs.

---

## Troubleshooting

* **First run downloads engines** — the first time a new Prisma version is used it will download engines; subsequent runs are faster if you cache `~/.cache/prisma`.
* **Lock errors between DBs** — migrations run sequentially. If you need parallelism, run separate jobs with a matrix (one DB per job).
* **Action fails but logs show a non-zero code** — check `results` output and the per-DB logs; consider `fail-fast: "false"` to collect status from all DBs.
* **CLI entry not found** — ensure `action` built and `dist/index.js` exists (see `SETUP.md`).

---

## Contributing & Releases

1. Fork the repo and create a feature branch.
2. Make your changes and add tests if applicable.
3. Open a pull request against `main`.
4. After review and merge, create a new release via GitHub UI or CLI.
5. The release will trigger a GitHub Action to build and publish the new version to npm.

## Examples

Below are practical examples you can copy into your workflows.

---

### 1) Single database (simple)

```yaml
name: Migrate single DB

on:
  push:
    branches: [ main ]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Prisma Migrate
        uses: your-org/action-prisma-migrate@v1
        with:
          prisma-version: "latest"
          schema: "prisma/schema.prisma"
          database-urls: ${{ secrets.DATABASE_URL }}
          prisma-args: ""
          fail-fast: "true"
````

---

### 2) Multiple DBs — JSON array

```yaml
- name: Run Prisma Migrate (many DBs)
  uses: your-org/action-prisma-migrate@v1
  with:
    prisma-version: "6.16.1"
    schema: "apps/api/prisma/schema.prisma"
    database-urls: '["${{ secrets.PROD_DATABASE_URL }}","${{ secrets.REPLICA_DATABASE_URL }}"]'
    prisma-args: "--telemetry-information=false"
    fail-fast: "false"
```

> Tip: wrap the JSON array in single quotes so YAML parsing doesn't break.

---

### 3) Comma / newline separated list

```yaml
database-urls: |
  ${{ secrets.DB_PRIMARY }}
  ${{ secrets.DB_SECONDARY }}
  ${{ secrets.DB_REPORTING }}
```

The action will split on newlines and commas and process each entry.

---

### 4) Parallelize per-database (matrix)

If you prefer running each DB in parallel to speed up pipeline time:

```yaml
jobs:
  migrate:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        db-url: [ ${{ secrets.DB_1 }}, ${{ secrets.DB_2 }} ]
    steps:
      - uses: actions/checkout@v4
      - name: Run Prisma for one DB
        uses: your-org/action-prisma-migrate@v1
        with:
          prisma-version: latest
          database-urls: ${{ matrix.db-url }}
          schema: prisma/schema.prisma
```

---

### 5) Monorepo: Use `working-directory`

```yaml
with:
  prisma-version: "latest"
  working-directory: "apps/api"
  schema: "prisma/schema.prisma"
  database-urls: ${{ secrets.APP_API_DB }}
```

---

### 6) Read the output

After the step finishes, `results` will be available as an output of the action step:

```yaml
- name: Run Prisma
  id: migrate
  uses: your-org/action-prisma-migrate@v1
  with:
    prisma-version: latest
    database-urls: ${{ secrets.DB }}

- name: Show results
  run: echo "${{ steps.migrate.outputs.results }}"
```

Example JSON output:

```json
[
  {"databaseUrlMasked":"postgres://***:***@...","ok":true,"exitCode":0,"ms":1023},
  {"databaseUrlMasked":"mysql://***:***@...","ok":false,"exitCode":2,"ms":4567}
]
```

---

### 7) Performance: cache Prisma engines

Recommended to cache Prisma engine downloads across runs:

```yaml
- name: Cache Prisma & npm
  uses: actions/cache@v4
  with:
    path: |
      ~/.cache/prisma
      ~/.npm/_cacache
    key: prisma-engines-${{ runner.os }}-${{ hashFiles('**/package-lock.json','**/pnpm-lock.yaml','**/yarn.lock') }}
```

This reduces first-run downloads for Prisma engines.

---

# Security

- All database URLs are automatically masked in GitHub Actions logs
- Use GitHub Secrets to store sensitive database connection strings
- No database credentials are logged or exposed in workflow summaries

# Versioning
We recommend pinning to the latest available major version:

```yaml
- uses: '@weprograpp/prisma-migrate@v1'
```
  While this action attempts to follow semantic versioning, but we're ultimately human and sometimes make mistakes. To prevent accidental breaking changes, you can also pin to a specific version:

```yaml
- uses: '@weprograpp/prisma-migrate@v1.0.0'
```
  However, you will not get automatic security updates or new features without explicitly updating your version number. Note that we only publish MAJOR and MAJOR.MINOR.PATCH versions. There is not a floating alias for MAJOR.MINOR.