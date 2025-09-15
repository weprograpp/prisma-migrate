# Prisma Migrate GitHub Actions

A comprehensive GitHub Action and reusable workflow to run `prisma migrate deploy` across one or many databases without the need to install packages in your workflow.

## 🚀 Features

- ✅ **Single or Multiple Databases**: Support for single database URL or JSON array of URLs
- 🔒 **Secret Masking**: Automatically masks database URLs in logs for security
- 🚀 **Sequential Execution**: Runs migrations sequentially with built-in concurrency control
- 🔍 **Dry Run Support**: Preview migrations without applying changes
- 📊 **Detailed Summaries**: Generates comprehensive reports via `$GITHUB_STEP_SUMMARY`
- 🛡️ **No Resets**: Designed specifically for `migrate deploy` (no destructive operations)
- ⚙️ **Configurable**: Custom Prisma versions, schema paths, and working directories
- 🔄 **Reusable Workflow**: Ready-to-use workflow with manual dispatch support

## 📦 What's Included

This repository provides two main components:

1. **Composite Action** (`.github/actions/prisma-migrate/`) - Core migration logic
2. **Reusable Workflow** (`.github/workflows/prisma-migrate.yml`) - Production-ready workflow

## 🛠️ Usage

### Option 1: Use the Composite Action

```yaml
name: Deploy Database Migrations

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

### Option 2: Use the Reusable Workflow

```yaml
name: Deploy Database Migrations

on:
  push:
    branches: [main]

jobs:
  migrate:
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets.DATABASE_URL }}
      schema-path: 'prisma/schema.prisma'
      prisma-version: '5.0.0'
      dry-run: false
    secrets:
      database-urls: ${{ secrets.DATABASE_URL }}
```

### Multiple Databases Example

```yaml
- name: Migrate Multiple Databases
  uses: weprograpp/prisma-migrate/.github/actions/prisma-migrate@main
  with:
    database-url: |
      [
        "${{ secrets.PROD_DATABASE_URL }}",
        "${{ secrets.STAGING_DATABASE_URL }}",
        "${{ secrets.TEST_DATABASE_URL }}"
      ]
    schema-path: 'apps/api/prisma/schema.prisma'
    working-directory: 'apps/api'
```

## 🎯 Manual Dispatch Example

The reusable workflow supports manual triggering through GitHub's workflow dispatch:

1. Go to **Actions** tab in your repository
2. Select **Prisma Migrate Deploy** workflow
3. Click **Run workflow**
4. Fill in the parameters:
   - **Database URL**: Your database connection string
   - **Schema Path**: Path to your Prisma schema
   - **Prisma Version**: Version to use (default: latest)
   - **Dry Run**: Check to preview changes only
   - **Working Directory**: Directory to run commands in

## 📋 Input Parameters

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `database-url` | Single database URL or JSON array | ✅ Yes | - |
| `schema-path` | Path to Prisma schema file | ❌ No | `prisma/schema.prisma` |
| `prisma-version` | Prisma CLI version to use | ❌ No | `latest` |
| `dry-run` | Preview mode without applying changes | ❌ No | `false` |
| `working-directory` | Directory to run commands in | ❌ No | `.` |

## 🔐 Security Best Practices

1. **Always use GitHub Secrets** for database URLs:
   ```yaml
   database-url: ${{ secrets.DATABASE_URL }}
   ```

2. **For multiple databases**, use the `secrets` input in reusable workflows:
   ```yaml
   secrets:
     database-urls: ${{ secrets.ALL_DATABASE_URLS }}
   ```

3. **Database URLs are automatically masked** in logs for security

## 📊 Output and Summaries

The action provides detailed summaries in the GitHub Actions interface:

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

## 🔄 Concurrency Control

The reusable workflow includes built-in concurrency control:

```yaml
concurrency:
  group: prisma-migrate-${{ github.repository }}
  cancel-in-progress: false
```

This ensures only one migration workflow runs at a time per repository.

## 📚 Examples

### Basic Production Deployment

```yaml
name: Production Deploy

on:
  release:
    types: [published]

jobs:
  migrate-and-deploy:
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets.PROD_DATABASE_URL }}
      schema-path: 'prisma/schema.prisma'
      prisma-version: '5.0.0'
    secrets:
      database-urls: ${{ secrets.PROD_DATABASE_URL }}
```

### Multi-Environment Deployment

```yaml
name: Multi-Environment Migration

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - staging
          - production

jobs:
  migrate:
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets[format('{0}_DATABASE_URL', github.event.inputs.environment)] }}
      schema-path: 'prisma/schema.prisma'
      dry-run: ${{ github.event.inputs.environment == 'production' && true || false }}
```

### Preview Mode with Pull Requests

```yaml
name: Preview Migrations

on:
  pull_request:
    paths:
      - 'prisma/**'

jobs:
  preview:
    uses: weprograpp/prisma-migrate/.github/workflows/prisma-migrate.yml@main
    with:
      database-url: ${{ secrets.STAGING_DATABASE_URL }}
      schema-path: 'prisma/schema.prisma'
      dry-run: true
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License.
