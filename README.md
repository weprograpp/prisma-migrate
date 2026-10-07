# Prisma Operations GitHub Action

Reusable GitHub Action for cached Prisma execution. It prepares the Prisma CLI, client, engines, and `tsx`, then runs `generate`, `migrate deploy`, and/or `db seed` without requiring a full project `npm ci`. Seeds with other runtime imports must declare them through `runtime-dependencies` or use an existing project `node_modules`.

## What it does

- Supports `prisma-version` selection, including exact versions like `5.22.0`, tags like `latest`, and semver ranges.
- Runs `prisma generate`, `prisma migrate deploy`, and `prisma db seed` independently.
- Supports one `database-url` or many `database-urls`.
- Keeps the Prisma download cached between runs.
- Can prepare the runtime while infrastructure is provisioning, then execute migrations after the database exists.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `mode` | `prepare` installs/restores the runtime; `execute` runs operations | `execute` |
| `prisma-version` | Prisma CLI version, tag, or semver range | `5.22.0` |
| `working-directory` | Working directory for the Prisma project | `.` |
| `runtime-directory` | Runtime returned by a previous `prepare` step | _empty_ |
| `runtime-dependencies` | JSON object of additional runtime packages pinned to exact versions | `{}` |
| `schema` | Path to `schema.prisma` | `prisma/schema.prisma` |
| `database-url` | Single `DATABASE_URL` | _empty_ |
| `database-urls` | One or more `DATABASE_URL` values | _empty_ |
| `generate` | Run `prisma generate` | `false` |
| `migrate` | Run `prisma migrate deploy` | `true` |
| `seed` | Run `prisma db seed` | `false` |
| `prisma-args` | Extra args appended to `prisma migrate deploy` | _empty_ |
| `fail-fast` | Stop after the first failed database operation | `true` |

## Outputs

| Output | Description |
| --- | --- |
| `runtime-directory` | Absolute path to the prepared runtime |
| `setup-ms` | Runtime preparation/restore time in milliseconds |
| `results` | JSON array with per-operation timings and status |

## Examples

### Migration only

```yaml
- name: Run Prisma migrate
  uses: weprograpp/prisma-migrate@v0.2.1
  with:
    prisma-version: "5.22.0"
    database-url: ${{ secrets.DATABASE_URL }}
```

### Full bootstrap

```yaml
- name: Generate, migrate, and seed
  uses: weprograpp/prisma-migrate@v0.2.1
  with:
    prisma-version: "5.22.0"
    working-directory: "platsage"
    schema: "prisma/schema.prisma"
    database-url: ${{ secrets.DATABASE_CONNECTION_STRING }}
    generate: "true"
    migrate: "true"
    seed: "true"
```

### Prepare while infrastructure is provisioning

Start the infrastructure build first, then prepare Prisma before waiting for the database:

```yaml
- name: Prepare Prisma runtime
  id: prisma-prepare
  uses: weprograpp/prisma-migrate@v0.3.0
  with:
    mode: prepare
    prisma-version: "5.22.0"
    working-directory: "tavaro"
    runtime-dependencies: '{"zod":"3.25.1"}'

- name: Wait for database infrastructure
  run: ./wait-for-infrastructure.sh

- name: Migrate and seed
  uses: weprograpp/prisma-migrate@v0.3.0
  with:
    mode: execute
    runtime-directory: ${{ steps.prisma-prepare.outputs.runtime-directory }}
    working-directory: "tavaro"
    runtime-dependencies: '{"zod":"3.25.1"}'
    database-url: ${{ secrets.DATABASE_CONNECTION_STRING }}
    generate: "true"
    migrate: "true"
    seed: "true"
```

If your schema uses `env("DATABASE_URL")`, pass a database URL even for `generate` so Prisma can resolve the datasource environment variable.

## Notes

- `database-urls` accepts a JSON array, a newline-separated list, or a comma-separated list.
- `prisma-args` is passed to `prisma migrate deploy` only.
- If multiple database URLs are provided, `generate` uses the first one to satisfy schemas that rely on `DATABASE_URL`.
- The composite wrapper restores `~/.cache/prisma-migrate` with `actions/cache`; the cache key is scoped by OS, architecture, runtime revision, and Prisma version.
- Each dependency-free project gets an isolated copy of the prepared runtime, so generated Prisma clients never write into the shared cache or another workspace.
- `runtime-dependencies` accepts package names mapped to exact semantic versions. Pass the same value to `prepare` and `execute` so those packages can be installed during the parallel preparation phase.
- Existing project dependencies are never replaced. When `node_modules` already exists, every declared runtime dependency must already be installed there.
- Node.js 20 is configured for both `prepare` and `execute` invocations.
- Set `PRISMA_MIGRATE_CACHE_DIR` if you want to store the downloaded Prisma versions in a custom cache location.

## Build

```bash
npm install
npm run build
```

The bundled `dist/index.js` is committed so the action can be consumed directly from GitHub.
