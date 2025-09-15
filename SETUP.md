# Setup and Troubleshooting Guide

## Initial Setup

### 1. Repository Secrets Setup

Go to your repository Settings → Secrets and variables → Actions, then add:

#### Single Database
```
DATABASE_URL = postgresql://username:password@host:port/database
```

#### Multiple Databases
```
DATABASE_URLS = ["postgresql://user:pass@host1:5432/db1", "postgresql://user:pass@host2:5432/db2"]
```

#### Environment-specific Secrets
```
STAGING_DATABASE_URL = postgresql://user:pass@staging-host:5432/staging_db
PRODUCTION_DATABASE_URL = postgresql://user:pass@prod-host:5432/prod_db
```

### 2. Directory Structure

Ensure your repository has the following structure:
```
your-repo/
├── prisma/
│   └── schema.prisma
├── .github/
│   └── workflows/
│       └── your-workflow.yml
└── ... (your project files)
```

### 3. Prisma Schema Requirements

Your `prisma/schema.prisma` should have a valid datasource:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql" // or "mysql", "sqlite", etc.
  url      = env("DATABASE_URL")
}

// ... your models
```

## Common Issues and Solutions

### Issue 1: "Schema file not found"

**Error**: `Schema file not found at ./prisma/schema.prisma`

**Solutions**:
- Check that your schema file exists in the correct location
- Update the `schema-path` input if your schema is in a different location
- For monorepos, use `working-directory` input

```yaml
- uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
  with:
    database-url: ${{ secrets.DATABASE_URL }}
    schema-path: 'apps/api/prisma/schema.prisma'  # Custom path
    working-directory: 'apps/api'                  # Custom working directory
```

### Issue 2: "Database connection failed"

**Error**: `Can't reach database server`

**Solutions**:
- Verify your DATABASE_URL format
- Ensure the database server is accessible from GitHub Actions
- Check firewall settings
- Verify credentials and database name

**Correct URL formats**:
```bash
# PostgreSQL
postgresql://username:password@host:port/database

# MySQL
mysql://username:password@host:port/database

# SQLite (file-based)
file:./dev.db
```

### Issue 3: "Invalid JSON array for multiple databases"

**Error**: `Error parsing database URLs`

**Solutions**:
- Ensure JSON array syntax is correct
- Use proper escaping in secrets
- Test JSON validity

**Correct format**:
```json
[
  "postgresql://user:pass@host1:5432/db1",
  "postgresql://user:pass@host2:5432/db2"
]
```

**In GitHub Secrets** (no escaping needed):
```
["postgresql://user:pass@host1:5432/db1", "postgresql://user:pass@host2:5432/db2"]
```

### Issue 4: "Migration failed" with no clear error

**Solutions**:
1. Run in dry-run mode first to preview changes:
   ```yaml
   with:
     database-url: ${{ secrets.DATABASE_URL }}
     dry-run: true
   ```

2. Check the migration status manually:
   ```bash
   npx prisma migrate status
   ```

3. Ensure migrations are committed to your repository:
   ```
   prisma/
   └── migrations/
       ├── 20240101000000_init/
       │   └── migration.sql
       └── migration_lock.toml
   ```

### Issue 5: "Prisma version mismatch"

**Error**: `CLI version doesn't match schema requirements`

**Solution**: Specify the exact Prisma version:
```yaml
- uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
  with:
    database-url: ${{ secrets.DATABASE_URL }}
    prisma-version: '5.0.0'  # Match your project's version
```

### Issue 6: "Concurrency control conflicts"

**Error**: `Another migration is already running`

This is actually a safety feature. Solutions:
- Wait for the current migration to complete
- Cancel the conflicting workflow if it's stuck
- The concurrency group is: `prisma-migrate-${{ github.repository }}`

### Issue 7: "Missing environment variables"

**Error**: `Environment variable not found: DATABASE_URL`

This happens when using the composite action directly. Solutions:
1. The action sets DATABASE_URL automatically from the input
2. If you need additional env vars, set them explicitly:
   ```yaml
   - uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
     env:
       CUSTOM_VAR: ${{ secrets.CUSTOM_VAR }}
     with:
       database-url: ${{ secrets.DATABASE_URL }}
   ```

## Debugging Tips

### Enable Debug Logging

Add this to your workflow for verbose output:
```yaml
env:
  ACTIONS_STEP_DEBUG: true
  ACTIONS_RUNNER_DEBUG: true
```

### Test Locally

Before using in CI/CD, test your migrations locally:
```bash
# Set your database URL
export DATABASE_URL="postgresql://..."

# Check migration status
npx prisma migrate status

# Preview migrations (dry run)
npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma

# Apply migrations
npx prisma migrate deploy
```

### Check Action Summaries

The action generates detailed summaries in the GitHub Actions interface. Look for:
- Number of databases processed
- Success/failure status for each database
- Detailed error messages

## Support

If you encounter issues not covered here:

1. Check the [GitHub Actions logs] for detailed error messages
2. Verify your Prisma schema syntax
3. Test your database connection outside of GitHub Actions
4. Review the [Prisma documentation](https://www.prisma.io/docs/concepts/components/prisma-migrate)

## Advanced Configuration

### Custom Migration Timeout

For large migrations, you may need to increase timeouts:
```yaml
jobs:
  migrate:
    timeout-minutes: 30  # Increase from default 6 hours
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
```

### Skip Migration Lock

⚠️ **Dangerous**: Only use if you understand the implications
```yaml
# This bypasses Prisma's migration lock mechanism
# Only use in controlled environments
env:
  PRISMA_MIGRATE_SKIP_SEED: true
```

### Custom Node.js Version

The action uses Node.js 18 by default. This is currently not customizable, but you can run setup steps before calling the action:
```yaml
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: '20'  # This will be overridden by the action
  
  - uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
    # ... rest of configuration
```