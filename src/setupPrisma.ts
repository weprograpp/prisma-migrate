import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import semver from "semver";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

type NpmMeta = {
  "dist-tags": Record<string, string>;
  versions: Record<string, { dist: { tarball: string } }>;
};

function fetchJson<T = unknown>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function resolveVersion(requestedVersion: string, meta: NpmMeta): string {
  const normalized = requestedVersion.trim();

  if (!normalized || normalized === "latest") {
    return meta["dist-tags"].latest;
  }

  if (meta.versions[normalized]) {
    return normalized;
  }

  const taggedVersion = meta["dist-tags"][normalized];
  if (taggedVersion && meta.versions[taggedVersion]) {
    return taggedVersion;
  }

  const availableVersions = Object.keys(meta.versions).filter((version) => semver.valid(version));
  const matchedVersion = semver.maxSatisfying(availableVersions, normalized, {
    includePrerelease: true
  });

  if (matchedVersion) {
    return matchedVersion;
  }

  throw new Error(`Could not resolve Prisma version: ${requestedVersion}`);
}

async function resolvePrisma(versionInput: string) {
  const meta = await fetchJson<NpmMeta>("https://registry.npmjs.org/prisma");
  const version = resolveVersion(versionInput, meta);
  const tarball = meta.versions[version].dist.tarball;
  return { version, tarball };
}

function getCacheRoot() {
  const raw = process.env.PRISMA_MIGRATE_CACHE_DIR?.trim();

  if (!raw) {
    return path.join(os.homedir(), ".cache", "prisma-migrate");
  }

  if (raw === "~") {
    return os.homedir();
  }

  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }

  return raw;
}

async function copyExtractedCli(sourceDir: string, targetDir: string) {
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.promises.cp(sourceDir, targetDir, { recursive: true });
}

export async function ensurePrismaCli(versionInput: string) {
  const resolved = await resolvePrisma(versionInput);
  const cacheRoot = getCacheRoot();
  const packageCacheDir = path.join(cacheRoot, resolved.version, "package");
  const rootCacheDir = path.join(cacheRoot, resolved.version);
  const packageCachedCli = path.join(packageCacheDir, "build", "index.js");
  const rootCachedCli = path.join(rootCacheDir, "build", "index.js");

  if (fs.existsSync(packageCachedCli)) {
    core.info(`Prisma CLI cache hit: ${resolved.version}`);
    core.addPath(path.dirname(packageCachedCli));
    return packageCachedCli;
  }

  if (fs.existsSync(rootCachedCli)) {
    core.info(`Prisma CLI cache hit: ${resolved.version}`);
    core.addPath(path.dirname(rootCachedCli));
    return rootCachedCli;
  }

  core.info(`Downloading Prisma CLI ${resolved.version}...`);
  const tgz = await tc.downloadTool(resolved.tarball);
  const extracted = await tc.extractTar(tgz);

  const extractedPackageCli = path.join(extracted, "package", "build", "index.js");
  const extractedRootCli = path.join(extracted, "build", "index.js");

  let cachedCli = "";
  if (fs.existsSync(extractedPackageCli)) {
    await copyExtractedCli(path.join(extracted, "package"), packageCacheDir);
    cachedCli = packageCachedCli;
  } else if (fs.existsSync(extractedRootCli)) {
    await copyExtractedCli(extracted, rootCacheDir);
    cachedCli = rootCachedCli;
  } else {
    throw new Error(`Prisma CLI entry not found in extracted tarball at ${extracted}`);
  }

  if (!fs.existsSync(cachedCli)) {
    throw new Error(`Prisma CLI entry not found at ${cachedCli}`);
  }

  core.addPath(path.dirname(cachedCli));
  return cachedCli;
}
