# Setup & Publishing guide

This file explains how to set up the project locally, build the action, run basic tests, and publish a release.

---

## Prerequisites

- Node.js 18+ / 20 recommended
- `npm` (or `pnpm`/`yarn`)
- Git & GitHub access to publish releases

---

## Local dev & build

1. Clone the repo
```bash
git clone git@github.com:your-org/action-prisma-migrate.git
cd action-prisma-migrate
````

2. Install deps

```bash
npm install
```

3. Build the action (bundles TypeScript into `dist/index.js`)

```bash
npm run build
# script: "build": "ncc build src/index.ts -o dist --minify"
```

4. Commit the build artifacts

> GitHub recommends committing `dist/` for JS-based actions to avoid a build step during job runs.

```bash
git add dist action.yml package.json package-lock.json
git commit -m "build: dist for release"
```

---

## Run & test locally with `act` (optional)

You can test workflows locally using `act`. `act` requires Docker and local secret definitions.

```bash
act -j migrate
```

This is optional and helpful for quick validations.

---

## Release & publish

1. Tag a release:

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin --tags
```

2. Create a GitHub Release (web UI or `gh` CLI). After tagging, add release notes and publish.

3. (Optional) Publish to GitHub Marketplace:

* Navigate to repository → Actions → Publish to Marketplace.
* Provide README and example workflows.

---

## Recommended CI for this repo

Create `.github/workflows/ci.yml` to run TypeScript checks, build and optional tests:

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: npm test || true
```

---

## Caching strategy for callers

To speed up execution in workflows that call this action:

1. Cache Prisma engines:

```yaml
- name: Cache Prisma & npm
  uses: actions/cache@v4
  with:
    path: |
      ~/.cache/prisma
      ~/.npm/_cacache
    key: prisma-engines-${{ runner.os }}-${{ hashFiles('**/package-lock.json','**/pnpm-lock.yaml','**/yarn.lock') }}
```

2. Pin `prisma-version` for deterministic runs.

---

## Common troubleshooting

* **`dist/index.js` missing**: run `npm run build` and commit `dist/`.
* **Engine downloads taking long**: add the cache step above.
* **DB connection fails**: validate secrets and network access; test locally with the same `DATABASE_URL`.
* **I want a Docker variant**: build a Docker action image with Prisma preinstalled — I can provide a Dockerfile if needed.