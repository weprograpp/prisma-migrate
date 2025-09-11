# Prisma Migrate Deploy Action

A composite GitHub Action that runs `prisma migrate deploy` across one or many databases with concurrency control and secret masking.

## Features

- ✅ **Single or Multiple Databases**: Support for single database URL or JSON array of URLs
- 🔒 **Secret Masking**: Automatically masks database URLs in logs
- 🚀 **Sequential Execution**: Runs migrations sequentially with built-in concurrency control
- 🔍 **Dry Run Support**: Preview migrations without applying changes
- 📊 **Detailed Summaries**: Generates comprehensive reports via `$GITHUB_STEP_SUMMARY`
- 🛡️ **No Resets**: Designed specifically for `migrate deploy` (no destructive operations)
- ⚙️ **Configurable**: Custom Prisma versions, schema paths, and working directories

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `database-url` | Single database URL or JSON array of database URLs | ✅ Yes | - |
| `schema-path` | Path to Prisma schema file | ❌ No | `prisma/schema.prisma` |
| `prisma-version` | Prisma version to use | ❌ No | `latest` |
| `dry-run` | Run in dry-run mode (preview changes without applying) | ❌ No | `false` |
| `working-directory` | Working directory to run commands in | ❌ No | `.` |

## Outputs

| Output | Description |
|--------|-------------|
| `databases-migrated` | Number of databases successfully migrated |
| `migration-summary` | Summary of migration results |

## Usage

### Single Database

```yaml
- name: Run Prisma Migration
  uses: ./.github/actions/prisma-migrate
  with:
    database-url: ${{ secrets.DATABASE_URL }}
    schema-path: 'prisma/schema.prisma'
    prisma-version: '5.0.0'
```

### Multiple Databases

```yaml
- name: Run Prisma Migration
  uses: ./.github/actions/prisma-migrate
  with:
    database-url: |
      [
        "${{ secrets.DATABASE_URL_1 }}",
        "${{ secrets.DATABASE_URL_2 }}",
        "${{ secrets.DATABASE_URL_3 }}"
      ]
    schema-path: 'apps/api/prisma/schema.prisma'
    working-directory: 'apps/api'
```

### Dry Run Mode

```yaml
- name: Preview Prisma Migration
  uses: ./.github/actions/prisma-migrate
  with:
    database-url: ${{ secrets.DATABASE_URL }}
    dry-run: true
```

## Database URL Format

### Single Database
```
postgresql://username:password@host:port/database
```

### Multiple Databases (JSON Array)
```json
[
  "postgresql://user:pass@host1:5432/db1",
  "postgresql://user:pass@host2:5432/db2",
  "mysql://user:pass@host3:3306/db3"
]
```

## Security

- All database URLs are automatically masked in GitHub Actions logs
- Use GitHub Secrets to store sensitive database connection strings
- No database credentials are logged or exposed in workflow summaries

## Example Output

The action generates a comprehensive summary in `$GITHUB_STEP_SUMMARY`:

```
## 🗄️ Prisma Migration Summary

**Mode:** Deploy
**Schema:** `prisma/schema.prisma`
**Prisma Version:** latest
**Working Directory:** `.`

### Results
- **Databases Processed:** 3
- **Successful:** 3
- **Failed:** 0

### Details
Database 1: ✅ Migration completed
Database 2: ✅ Migration completed
Database 3: ✅ Migration completed
```

## Requirements

- Node.js 18+ (automatically installed by the action)
- Valid Prisma schema file
- Database(s) accessible from GitHub Actions runner