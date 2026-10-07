import * as core from "@actions/core";
import * as exec from "@actions/exec";
import semver from "semver";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

const RUNTIME_REVISION = "3";
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

export type RuntimeDependencies = Record<string, string>;

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

export function parseRuntimeDependencies(raw: string): RuntimeDependencies {
  if (!raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("runtime-dependencies must be a JSON object of package names to exact versions.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime-dependencies must be a JSON object of package names to exact versions.");
  }

  const dependencies = Object.entries(parsed as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

  for (const [name, version] of dependencies) {
    if (!packageNamePattern.test(name)) {
      throw new Error(`Invalid runtime dependency package name: ${name}`);
    }
    if (name === "prisma" || name === "@prisma/client" || name === "tsx") {
      throw new Error(`${name} is managed by prisma-migrate and must not be overridden.`);
    }
    if (typeof version !== "string" || !semver.valid(version)) {
      throw new Error(`runtime-dependencies must pin an exact semver version for ${name}.`);
    }
  }

  return Object.fromEntries(dependencies) as RuntimeDependencies;
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

function dependencyPackagePath(nodeModules: string, packageName: string) {
  return path.join(nodeModules, ...packageName.split("/"), "package.json");
}

function getWorkspaceRuntimeRoot(
  cwd: string,
  runtime: PrismaRuntime,
  runtimeDependencies: RuntimeDependencies
) {
  const base = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ cwd, runtime: runtime.directory, runtimeDependencies }))
    .digest("hex")
    .slice(0, 20);
  return path.join(base, "prisma-migrate-workspaces", fingerprint);
}

async function assertExistingDependencies(
  nodeModules: string,
  runtimeDependencies: RuntimeDependencies
) {
  for (const packageName of Object.keys(runtimeDependencies)) {
    if (!fs.existsSync(dependencyPackagePath(nodeModules, packageName))) {
      throw new Error(
        `Existing project dependencies do not contain ${packageName}. Install it before running the action.`
      );
    }
  }
}

export async function materializePrismaRuntime(
  runtime: PrismaRuntime,
  workingDirectory: string,
  runtimeDependencies: RuntimeDependencies = {}
) {
  const cwd = path.resolve(workingDirectory);
  const target = path.join(cwd, "node_modules");
  const source = runtimePaths(runtime.directory).nodeModules;
  const workspaceRuntimeRoot = getWorkspaceRuntimeRoot(cwd, runtime, runtimeDependencies);
  const workspaceNodeModules = path.join(workspaceRuntimeRoot, "node_modules");
  const current = await fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

  if (current) {
    if (current.isSymbolicLink()) {
      const resolvedTarget = await fs.promises.realpath(target);
      const resolvedWorkspace = await fs.promises.realpath(workspaceNodeModules).catch(() => "");
      if (resolvedTarget !== resolvedWorkspace) {
        throw new Error(`Refusing to replace existing node_modules symlink at ${target}.`);
      }
    } else {
      await assertExistingDependencies(target, runtimeDependencies);
      core.info(`Using existing project dependencies at ${target}.`);
    }
    return;
  }

  await fs.promises.mkdir(cwd, { recursive: true });
  await fs.promises.rm(workspaceRuntimeRoot, { recursive: true, force: true });
  await fs.promises.mkdir(workspaceRuntimeRoot, { recursive: true });
  await fs.promises.cp(source, workspaceNodeModules, { recursive: true });
  await fs.promises.rm(path.join(workspaceNodeModules, ".prisma"), {
    recursive: true,
    force: true
  });
  await fs.promises.writeFile(
    path.join(workspaceRuntimeRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "prisma-migrate-workspace-runtime",
        private: true,
        dependencies: {
          prisma: runtime.version,
          "@prisma/client": runtime.version,
          tsx: TSX_VERSION,
          ...runtimeDependencies
        }
      },
      null,
      2
    )}\n`
  );

  if (Object.keys(runtimeDependencies).length > 0) {
    core.info(`Installing ${Object.keys(runtimeDependencies).length} additional runtime dependencies...`);
    await exec.exec(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--prefer-offline"],
      { cwd: workspaceRuntimeRoot }
    );
  }

  await fs.promises.symlink(
    workspaceNodeModules,
    target,
    process.platform === "win32" ? "junction" : "dir"
  );
  core.info(`Materialized isolated Prisma runtime into ${target}.`);
}

export async function ensurePrismaCli(versionInput: string) {
  return (await ensurePrismaRuntime(versionInput)).cliEntry;
}
