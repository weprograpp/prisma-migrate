# Setup & publishing guide

This repository packages a reusable GitHub Action. The committed `dist/index.js` is what consumers execute.

## Prerequisites

- Node.js 20 recommended
- `npm`

## Local development

```bash
npm install
npm run build
```

`npm run build` bundles `src/index.ts` into `dist/index.js` with `ncc`.

## Releasing

1. Update `package.json` and the bundled `dist/index.js`.
2. Tag a release on the branch you want to publish.
3. Create or update the GitHub Release for that tag.

## Notes

- Keep `action.yml` and `dist/index.js` in sync.
- The action resolves Prisma versions from the npm registry, so `prisma-version: 5.22.0` works even if callers do not install Prisma locally.
