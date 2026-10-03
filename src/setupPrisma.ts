import * as core from "@actions/core";
import * as exec from "@actions/exec";
import semver from "semver";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

const RUNTIME_REVISION = "2";
const TSX_VERSION = "4.19.1";

type NpmMeta = {
  "dist-tags": Record<string, string>;
  versions: Record<string, unknown>;
};

export type PrismaRuntime = {
  version: string;
  directory: string;
  cliEntry: string;
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

export function resolveVersion(requestedVersion: string, meta: NpmMeta): string {
  const normalized = requestedVersion.trim();

  if (!normalized || normalized === "latest") return meta["dist-tags"].latest;
  if (meta.versions[normalized]) return normalized;

  const taggedVersion = meta["dist-tags"][normalized];
  if (taggedVersion && meta.versions[taggedVersion]) return taggedVersion;

  const availableVersions = Object.keys(meta.versions).filter((version) => semver.valid(version));
  const matchedVersion = semver.maxSatisfying(availableVersions, normalized, {
    includePrerelease: true
  });

  if (matchedVersion) return matchedVersion;
  throw new Error(`Could not resolve Prisma version: ${requestedVersion}`);
}

async function resolvePrismaVersion(versionInput: string) {
  if (semver.valid(versionInput.trim())) return versionInput.trim();
  const meta = await fetchJson<NpmMeta>("https://registry.npmjs.org/prisma");
  return resolveVersion(versionInput, meta);
}

export function getCacheRoot() {
  const raw = process.env.PRISMA_MIGRATE_CACHE_DIR?.trim();
  if (!raw) return path.join(os.homedir(), ".cache", "prisma-migrate");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function runtimePaths(directory: string) {
  return {
    manifest: path.join(directory, ".prisma-migrate-runtime.json"),
    nodeModules: path.join(directory, "node_modules"),
    cliEntry: path.join(directory, "node_modules", "prisma", "build", "index.js"),
    clientPackage: path.join(directory, "node_modules", "@prisma", "client", "package.json"),
    enginesPackage: path.join(directory, "node_modules", "@prisma", "engines", "package.json"),
    tsxEntry: path.join(directory, "node_modules", "tsx", "dist", "cli.mjs")
  };
}

function validateRuntimeFiles(directory: string) {
  const paths = runtimePaths(directory);
  return [paths.manifest, paths.cliEntry, paths.clientPackage, paths.enginesPackage, paths.tsxEntry].every(
    (file) => fs.existsSync(file)
  );
}

export async function loadPrismaRuntime(directory: string): Promise<PrismaRuntime> {
  const absoluteDirectory = path.resolve(directory);
  const paths = runtimePaths(absoluteDirectory);

  if (!validateRuntimeFiles(absoluteDirectory)) {
    throw new Error(`Prisma runtime is incomplete at ${absoluteDirectory}. Run mode=prepare first.`);
  }

  const manifest = JSON.parse(await fs.promises.readFile(paths.manifest, "utf8"));
  if (manifest.revision !== RUNTIME_REVISION || !semver.valid(manifest.prismaVersion)) {
    throw new Error(`Prisma runtime manifest is invalid at ${paths.manifest}.`);
  }

  return {
    version: manifest.prismaVersion,
    directory: absoluteDirectory,
    cliEntry: paths.cliEntry
  };
}

export async function ensurePrismaRuntime(versionInput: string): Promise<PrismaRuntime> {
  const version = await resolvePrismaVersion(versionInput);
  const directory = path.join(getCacheRoot(), `runtime-v${RUNTIME_REVISION}`, version);

  if (validateRuntimeFiles(directory)) {
    core.info(`Prisma runtime cache hit: ${version}`);
    return loadPrismaRuntime(directory);
  }

  core.info(`Preparing Prisma runtime ${version}...`);
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "prisma-migrate-runtime",
        private: true,
        dependencies: { prisma: version, "@prisma/client": version, tsx: TSX_VERSION }
      },
      null,
      2
    )}\n`
  );

  await exec.exec(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--prefer-offline"],
    { cwd: directory }
  );

  await fs.promises.writeFile(
    runtimePaths(directory).manifest,
    `${JSON.stringify({ revision: RUNTIME_REVISION, prismaVersion: version })}\n`
  );

  if (!validateRuntimeFiles(directory)) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw new Error(`Prisma runtime installation is incomplete for version ${version}.`);
  }

  return loadPrismaRuntime(directory);
}

export async function materializePrismaRuntime(runtime: PrismaRuntime, workingDirectory: string) {
  const cwd = path.resolve(workingDirectory);
  const target = path.join(cwd, "node_modules");
  const source = runtimePaths(runtime.directory).nodeModules;
  const current = await fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (current) {
    if (current.isSymbolicLink()) {
      const resolvedTarget = await fs.promises.realpath(target);
      const resolvedSource = await fs.promises.realpath(source);
      if (resolvedTarget !== resolvedSource) {
        throw new Error(`Refusing to replace existing node_modules symlink at ${target}.`);
      }
    } else {
      core.info(`Using existing project dependencies at ${target}.`);
    }
    return;
  }

  await fs.promises.mkdir(cwd, { recursive: true });
  await fs.promises.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  core.info(`Linked prepared Prisma runtime into ${target}.`);
}

export async function ensurePrismaCli(versionInput: string) {
  return (await ensurePrismaRuntime(versionInput)).cliEntry;
}
