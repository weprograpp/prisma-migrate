import * as core from "@actions/core";
import * as exec from "@actions/exec";
import semver from "semver";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

const RUNTIME_REVISION = "3";
const TSX_VERSION = "4.19.1";
const WORKSPACE_RUNTIME_REVISION = "1";
const WORKSPACE_RUNTIME_MANIFEST = ".prisma-migrate-workspace-runtime.json";
const WORKSPACE_LOCK_STALE_MS = 60 * 1000;
const WORKSPACE_LOCK_HEARTBEAT_MS = 10 * 1000;
const WORKSPACE_LOCK_CHOOSING_SUFFIX = ".choosing.json";
const WORKSPACE_LOCK_TICKET_SUFFIX = ".ticket.json";

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

type WorkspaceRuntimeDescriptor = {
  revision: string;
  runtimeDirectory: string;
  prismaVersion: string;
  runtimeDependencies: RuntimeDependencies;
};

function getWorkspaceBase() {
  const base = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
  return path.join(base, "prisma-migrate-workspaces");
}

function normalizeRuntimeDependencies(runtimeDependencies: RuntimeDependencies) {
  return Object.fromEntries(
    Object.entries(runtimeDependencies).sort(([left], [right]) => left.localeCompare(right))
  ) as RuntimeDependencies;
}

function getWorkspaceRuntimeDescriptor(
  runtime: PrismaRuntime,
  runtimeDependencies: RuntimeDependencies
): WorkspaceRuntimeDescriptor {
  return {
    revision: WORKSPACE_RUNTIME_REVISION,
    runtimeDirectory: path.resolve(runtime.directory),
    prismaVersion: runtime.version,
    runtimeDependencies: normalizeRuntimeDependencies(runtimeDependencies)
  };
}

function getWorkspaceRuntimePaths(
  cwd: string,
  descriptor: WorkspaceRuntimeDescriptor
) {
  const projectFingerprint = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  const runtimeFingerprint = createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex")
    .slice(0, 20);
  const projectRoot = path.join(getWorkspaceBase(), projectFingerprint);
  const runtimeRoot = path.join(projectRoot, runtimeFingerprint);
  return {
    projectRoot,
    runtimeRoot,
    nodeModules: path.join(runtimeRoot, "node_modules"),
    manifest: path.join(runtimeRoot, WORKSPACE_RUNTIME_MANIFEST),
    lock: path.join(projectRoot, ".materialize.lock")
  };
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

type WorkspaceLockParticipant = {
  pid: number;
  token: string;
  number?: number;
};

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function writeWorkspaceLockEntry(file: string, participant: WorkspaceLockParticipant) {
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(staging, `${JSON.stringify(participant)}\n`, { flag: "wx" });
    await fs.promises.rename(staging, file);
  } finally {
    await fs.promises.rm(staging, { force: true });
  }
}

async function readWorkspaceLockEntry(file: string) {
  const entryStat = await fs.promises.stat(file).catch(() => undefined);
  if (!entryStat) return { active: false, missing: true };
  const heartbeatIsFresh = Date.now() - entryStat.mtimeMs < WORKSPACE_LOCK_STALE_MS;

  try {
    const participant = JSON.parse(
      await fs.promises.readFile(file, "utf8")
    ) as Partial<WorkspaceLockParticipant>;
    if (
      typeof participant.pid === "number" &&
      participant.pid > 0 &&
      typeof participant.token === "string"
    ) {
      return {
        active: heartbeatIsFresh && isProcessAlive(participant.pid),
        participant: participant as WorkspaceLockParticipant
      };
    }
  } catch {
    // A participant can disappear while its owner releases the lock.
  }

  return { active: heartbeatIsFresh };
}

function startWorkspaceLockHeartbeat(ticketPath: string) {
  let stopped = false;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.promises.utimes(ticketPath, now, now).catch((error: NodeJS.ErrnoException) => {
      if (!stopped && error.code !== "ENOENT") {
        core.warning(`Could not refresh Prisma workspace lock at ${ticketPath}: ${error.message}`);
      }
    });
  }, WORKSPACE_LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  return () => {
    stopped = true;
    clearInterval(heartbeat);
  };
}

async function listWorkspaceLockParticipants(lock: string, suffix: string) {
  const names = (await fs.promises.readdir(lock)).filter((name) => name.endsWith(suffix));
  const participants: WorkspaceLockParticipant[] = [];
  let hasUnknownActiveEntry = false;

  for (const name of names) {
    const file = path.join(lock, name);
    const state = await readWorkspaceLockEntry(file);
    if (!state.active) {
      await fs.promises.rm(file, { force: true });
      if (!state.missing) core.warning(`Recovered abandoned Prisma workspace lock entry at ${file}.`);
    } else if (state.participant) {
      participants.push(state.participant);
    } else {
      hasUnknownActiveEntry = true;
    }
  }

  return { participants, hasUnknownActiveEntry };
}

export async function acquireWorkspaceLock(lock: string) {
  // Lamport's bakery algorithm keeps every contender in a unique file. That makes
  // abandoned-entry cleanup safe because a recovered path is never reused by a new owner.
  await fs.promises.mkdir(lock, { recursive: true });
  const token = randomUUID();
  const participant: WorkspaceLockParticipant = { pid: process.pid, token };
  const choosingPath = path.join(lock, `${token}${WORKSPACE_LOCK_CHOOSING_SUFFIX}`);
  const ticketPath = path.join(lock, `${token}${WORKSPACE_LOCK_TICKET_SUFFIX}`);
  await writeWorkspaceLockEntry(choosingPath, participant);
  let stopHeartbeat: (() => void) | undefined = startWorkspaceLockHeartbeat(choosingPath);

  try {
    let existingTickets: Awaited<ReturnType<typeof listWorkspaceLockParticipants>>;
    do {
      existingTickets = await listWorkspaceLockParticipants(
        lock,
        WORKSPACE_LOCK_TICKET_SUFFIX
      );
      if (existingTickets.hasUnknownActiveEntry) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } while (existingTickets.hasUnknownActiveEntry);

    participant.number =
      Math.max(
        0,
        ...existingTickets.participants.map((entry) =>
          Number.isSafeInteger(entry.number) ? entry.number! : 0
        )
      ) + 1;
    await writeWorkspaceLockEntry(ticketPath, participant);
    stopHeartbeat?.();
    await fs.promises.rm(choosingPath, { force: true });
    stopHeartbeat = startWorkspaceLockHeartbeat(ticketPath);

    while (true) {
      const choosing = await listWorkspaceLockParticipants(
        lock,
        WORKSPACE_LOCK_CHOOSING_SUFFIX
      );
      const tickets = await listWorkspaceLockParticipants(lock, WORKSPACE_LOCK_TICKET_SUFFIX);
      const invalidTicket = tickets.participants.some(
        (entry) => !Number.isSafeInteger(entry.number)
      );

      if (
        choosing.participants.length === 0 &&
        !choosing.hasUnknownActiveEntry &&
        !tickets.hasUnknownActiveEntry &&
        !invalidTicket
      ) {
        const orderedTickets = tickets.participants.sort(
          (left, right) => left.number! - right.number! || left.token.localeCompare(right.token)
        );
        if (!orderedTickets.some((entry) => entry.token === token)) {
          throw new Error(`Prisma workspace lock ticket disappeared at ${ticketPath}.`);
        }
        if (orderedTickets[0]?.token === token) {
          return async () => {
            stopHeartbeat?.();
            await fs.promises.rm(ticketPath, { force: true });
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    stopHeartbeat?.();
    await fs.promises.rm(choosingPath, { force: true });
    await fs.promises.rm(ticketPath, { force: true });
    throw error;
  }
}

async function assertExistingDependencies(
  nodeModules: string,
  runtimeDependencies: RuntimeDependencies
) {
  for (const [packageName, expectedVersion] of Object.entries(runtimeDependencies)) {
    const packagePath = dependencyPackagePath(nodeModules, packageName);
    let installedVersion: unknown;
    try {
      installedVersion = JSON.parse(await fs.promises.readFile(packagePath, "utf8")).version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(
        `Existing project dependencies do not contain ${packageName}@${expectedVersion}. Install it before running the action.`
      );
    }
    if (installedVersion !== expectedVersion) {
      throw new Error(
        `Existing project dependency ${packageName} must be ${expectedVersion}, but found ${String(installedVersion)}.`
      );
    }
  }
}

async function isWorkspaceRuntimeReady(
  runtimeRoot: string,
  nodeModules: string,
  manifest: string,
  descriptor: WorkspaceRuntimeDescriptor
) {
  try {
    if (!(await fs.promises.stat(nodeModules)).isDirectory()) return false;
    const currentDescriptor = JSON.parse(await fs.promises.readFile(manifest, "utf8"));
    if (JSON.stringify(currentDescriptor) !== JSON.stringify(descriptor)) return false;
    await assertExistingDependencies(nodeModules, descriptor.runtimeDependencies);
    return true;
  } catch {
    return false;
  }
}

async function prepareWorkspaceRuntime(
  runtime: PrismaRuntime,
  descriptor: WorkspaceRuntimeDescriptor,
  paths: ReturnType<typeof getWorkspaceRuntimePaths>
) {
  if (
    await isWorkspaceRuntimeReady(
      paths.runtimeRoot,
      paths.nodeModules,
      paths.manifest,
      descriptor
    )
  ) {
    return;
  }

  const stagingRoot = `${paths.runtimeRoot}.tmp-${process.pid}-${randomUUID()}`;
  const stagingNodeModules = path.join(stagingRoot, "node_modules");
  try {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    await fs.promises.cp(runtimePaths(runtime.directory).nodeModules, stagingNodeModules, {
      recursive: true
    });
    await fs.promises.rm(path.join(stagingNodeModules, ".prisma"), {
      recursive: true,
      force: true
    });
    await fs.promises.writeFile(
      path.join(stagingRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "prisma-migrate-workspace-runtime",
          private: true,
          dependencies: {
            prisma: runtime.version,
            "@prisma/client": runtime.version,
            tsx: TSX_VERSION,
            ...descriptor.runtimeDependencies
          }
        },
        null,
        2
      )}\n`
    );

    if (Object.keys(descriptor.runtimeDependencies).length > 0) {
      core.info(
        `Installing ${Object.keys(descriptor.runtimeDependencies).length} additional runtime dependencies...`
      );
      await exec.exec(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--prefer-offline"],
        { cwd: stagingRoot }
      );
      await assertExistingDependencies(stagingNodeModules, descriptor.runtimeDependencies);
    }

    await fs.promises.writeFile(
      path.join(stagingRoot, WORKSPACE_RUNTIME_MANIFEST),
      `${JSON.stringify(descriptor)}\n`
    );
    await fs.promises.rm(paths.runtimeRoot, { recursive: true, force: true });
    await fs.promises.rename(stagingRoot, paths.runtimeRoot);
  } finally {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function materializePrismaRuntime(
  runtime: PrismaRuntime,
  workingDirectory: string,
  runtimeDependencies: RuntimeDependencies = {}
) {
  const cwd = path.resolve(workingDirectory);
  const target = path.join(cwd, "node_modules");
  const descriptor = getWorkspaceRuntimeDescriptor(runtime, runtimeDependencies);
  const paths = getWorkspaceRuntimePaths(cwd, descriptor);
  const releaseLock = await acquireWorkspaceLock(paths.lock);

  try {
    await fs.promises.mkdir(cwd, { recursive: true });
    const current = await fs.promises.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });

    if (current && !current.isSymbolicLink()) {
      await assertExistingDependencies(target, descriptor.runtimeDependencies);
      core.info(`Using existing project dependencies at ${target}.`);
      return releaseLock;
    }

    if (current?.isSymbolicLink()) {
      const linkedPath = path.resolve(path.dirname(target), await fs.promises.readlink(target));
      if (!isPathInside(getWorkspaceBase(), linkedPath)) {
        throw new Error(`Refusing to replace existing node_modules symlink at ${target}.`);
      }
      if (
        linkedPath === paths.nodeModules &&
        (await isWorkspaceRuntimeReady(
          paths.runtimeRoot,
          paths.nodeModules,
          paths.manifest,
          descriptor
        ))
      ) {
        core.info(`Using materialized Prisma runtime at ${target}.`);
        return releaseLock;
      }
      await fs.promises.unlink(target);
    }

    await prepareWorkspaceRuntime(runtime, descriptor, paths);
    await fs.promises.symlink(
      paths.nodeModules,
      target,
      process.platform === "win32" ? "junction" : "dir"
    );
    core.info(`Materialized isolated Prisma runtime into ${target}.`);
    return releaseLock;
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

export async function ensurePrismaCli(versionInput: string) {
  return (await ensurePrismaRuntime(versionInput)).cliEntry;
}
