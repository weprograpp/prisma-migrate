# Usage Examples

This directory contains practical examples of how to use the Prisma Migrate GitHub Actions.

## Example 1: Basic Single Database Migration

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Prisma Migration
        uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
        with:
          database-url: ${{ secrets.DATABASE_URL }}
          schema-path: 'prisma/schema.prisma'
          prisma-version: 'latest'
```

## Example 2: Multiple Database Migration

```yaml
name: Multi-Database Migration

on:
  workflow_dispatch:

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Migrate All Databases
        uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
        with:
          database-url: |
            [
              "${{ secrets.DB_PRIMARY }}",
              "${{ secrets.DB_REPLICA_1 }}",
              "${{ secrets.DB_REPLICA_2 }}"
            ]
          schema-path: 'apps/api/prisma/schema.prisma'
          working-directory: 'apps/api'
```

## Example 3: Using the Reusable Workflow

```yaml
name: Reusable Migration Workflow

on:
  release:
    types: [published]

jobs:
  migrate-staging:
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets.STAGING_DATABASE_URL }}
      schema-path: 'prisma/schema.prisma'
      dry-run: true
    secrets:
      database-urls: ${{ secrets.STAGING_DATABASE_URL }}

  migrate-production:
    needs: migrate-staging
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets.PROD_DATABASE_URL }}
      schema-path: 'prisma/schema.prisma'
      dry-run: false
    secrets:
      database-urls: ${{ secrets.PROD_DATABASE_URL }}
```

## Example 4: Conditional Migration with Environment Matrix

```yaml
name: Environment Matrix Migration

on:
  workflow_dispatch:
    inputs:
      environments:
        description: 'Comma-separated environments'
        default: 'staging,production'
        required: true

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.set-matrix.outputs.matrix }}
    steps:
      - id: set-matrix
        run: |
          envs="${{ github.event.inputs.environments }}"
          matrix=$(echo "$envs" | jq -R 'split(",") | map({env: .})')
          echo "matrix=$matrix" >> $GITHUB_OUTPUT

  migrate:
    needs: prepare
    strategy:
      matrix: ${{ fromJson(needs.prepare.outputs.matrix) }}
      fail-fast: false
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets[format('{0}_DATABASE_URL', upper(matrix.env))] }}
      schema-path: 'prisma/schema.prisma'
      dry-run: ${{ matrix.env == 'production' }}
```

## Example 5: Migration with Custom Prisma Version

```yaml
name: Migration with Specific Prisma Version

on:
  push:
    paths:
      - 'prisma/**'

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Get Prisma Version
        id: prisma-version
        run: |
          version=$(cat package.json | jq -r '.dependencies.prisma // .devDependencies.prisma // "latest"')
          echo "version=$version" >> $GITHUB_OUTPUT
      
      - name: Run Migration
        uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
        with:
          database-url: ${{ secrets.DATABASE_URL }}
          schema-path: 'prisma/schema.prisma'
          prisma-version: ${{ steps.prisma-version.outputs.version }}
```

## Example 6: Manual Dispatch with Approval

```yaml
name: Production Migration (Manual Approval)

on:
  workflow_dispatch:
    inputs:
      database-url:
        description: 'Database URL'
        required: true
      confirm:
        description: 'Type "CONFIRM" to proceed with production migration'
        required: true

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Validate Confirmation
        run: |
          if [ "${{ github.event.inputs.confirm }}" != "CONFIRM" ]; then
            echo "::error::Must type 'CONFIRM' to proceed"
            exit 1
          fi

  migrate:
    needs: validate
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ github.event.inputs.database-url }}
      schema-path: 'prisma/schema.prisma'
      dry-run: false
```

## Security Best Practices

### Use GitHub Secrets
```yaml
# ✅ Good
database-url: ${{ secrets.DATABASE_URL }}

# ❌ Bad
database-url: 'postgresql://user:password@host:5432/db'
```

### Multiple Environment Secrets
```yaml
secrets:
  STAGING_DATABASE_URL: postgresql://...
  PRODUCTION_DATABASE_URL: postgresql://...
  DB_REPLICA_1: postgresql://...
  DB_REPLICA_2: postgresql://...
```

### JSON Array in Secrets
```yaml
# Store as secret named DATABASE_URLS:
[
  "postgresql://user:pass@primary:5432/db",
  "postgresql://user:pass@replica1:5432/db",
  "postgresql://user:pass@replica2:5432/db"
]
```