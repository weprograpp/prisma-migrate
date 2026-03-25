# Prisma Operations GitHub Action

Reusable GitHub Action for cached Prisma CLI execution. It downloads the Prisma version you request, caches it, and runs `generate`, `migrate deploy`, and/or `db seed` without requiring callers to run `npx prisma`.

## What it does

- Supports `prisma-version` selection, including exact versions like `5.22.0`, tags like `latest`, and semver ranges.
- Runs `prisma generate`, `prisma migrate deploy`, and `prisma db seed` independently.
- Supports one `database-url` or many `database-urls`.
- Keeps the Prisma download cached between runs.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `prisma-version` | Prisma CLI version, tag, or semver range | `5.22.0` |
| `working-directory` | Working directory for the Prisma project | `.` |
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
| `results` | JSON array with per-operation timings and status |

## Examples

### Migration only

```yaml
- name: Run Prisma migrate
  uses: weprograpp/prisma-migrate@v1
  with:
    prisma-version: "5.22.0"
    database-url: ${{ secrets.DATABASE_URL }}
```

### Full bootstrap

```yaml
- name: Generate, migrate, and seed
  uses: weprograpp/prisma-migrate@v1
  with:
    prisma-version: "5.22.0"
    working-directory: "platsage"
    schema: "prisma/schema.prisma"
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
- The composite wrapper restores `~/.cache/prisma-migrate` with `actions/cache`, and the cache key is scoped by the requested `prisma-version`.
- Set `PRISMA_MIGRATE_CACHE_DIR` if you want to store the downloaded Prisma versions in a custom cache location.

## Build

```bash
npm install
npm run build
```

The bundled `dist/index.js` is committed so the action can be consumed directly from GitHub.
