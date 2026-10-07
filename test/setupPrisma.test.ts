import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireWorkspaceLock,
  classifyWorkspaceLockOwnership,
  getWorkspaceLockName,
  loadPrismaRuntime,
  materializePrismaRuntime,
  parseRuntimeDependencies,
  resolveVersion,
  startCompatibilityHeartbeat,
  WORKSPACE_LOCK_OWNER_GRACE_MS,
  type PrismaRuntime
} from "../src/setupPrisma";

test("resolveVersion supports exact versions, tags, and ranges", () => {
  const meta = {
    "dist-tags": { latest: "5.22.0", next: "6.0.0-beta.1" },
    versions: { "5.21.0": {}, "5.22.0": {}, "6.0.0-beta.1": {} }
  };

  assert.equal(resolveVersion("5.21.0", meta), "5.21.0");
  assert.equal(resolveVersion("next", meta), "6.0.0-beta.1");
  assert.equal(resolveVersion("^5.0.0", meta), "5.22.0");
});

test("loadPrismaRuntime rejects incomplete runtimes", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-incomplete-"));
  await assert.rejects(loadPrismaRuntime(directory), /incomplete/);
  await fs.promises.rm(directory, { recursive: true, force: true });
});

test("parseRuntimeDependencies requires exact versions and protects managed packages", () => {
  assert.deepEqual(parseRuntimeDependencies('{"zod":"3.25.1","@sentry/node":"10.0.0"}'), {
    "@sentry/node": "10.0.0",
    zod: "3.25.1"
  });
  assert.throws(() => parseRuntimeDependencies('{"zod":"^3.25.0"}'), /exact semver/);
  assert.throws(() => parseRuntimeDependencies('{"prisma":"5.22.0"}'), /managed/);
});

test("getWorkspaceLockName isolates GitHub workflow attempts", () => {
  const firstAttempt = getWorkspaceLockName({
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1"
  });
  assert.equal(
    firstAttempt,
    getWorkspaceLockName({ GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "1" })
  );
  assert.notEqual(
    firstAttempt,
    getWorkspaceLockName({ GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2" })
  );
  assert.notEqual(firstAttempt, getWorkspaceLockName({ GITHUB_RUN_ID: "5678" }));
  assert.equal(getWorkspaceLockName({}), ".materialize.lock");
});

test("classifyWorkspaceLockOwnership fails safe when identity lookup is unavailable", () => {
  assert.equal(
    classifyWorkspaceLockOwnership("expected", { status: "unknown" }, 0),
    "active"
  );
  assert.equal(
    classifyWorkspaceLockOwnership(
      "expected",
      { status: "unknown" },
      WORKSPACE_LOCK_OWNER_GRACE_MS
    ),
    "uncertain"
  );
  assert.equal(
    classifyWorkspaceLockOwnership(
      "expected",
      { status: "unknown" },
      WORKSPACE_LOCK_OWNER_GRACE_MS * 10
    ),
    "uncertain"
  );
  assert.equal(
    classifyWorkspaceLockOwnership("expected", { status: "missing" }, 0),
    "abandoned"
  );
  assert.equal(
    classifyWorkspaceLockOwnership(
      "expected",
      { status: "found", value: "expected" },
      WORKSPACE_LOCK_OWNER_GRACE_MS * 10
    ),
    "active"
  );
  assert.equal(
    classifyWorkspaceLockOwnership(
      "expected",
      { status: "found", value: "recycled" },
      0
    ),
    "abandoned"
  );
});

test("compatibility heartbeat continues while the main event loop is blocked", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-lock-heartbeat-"));
  const entry = path.join(root, "active.ticket.json");
  await fs.promises.writeFile(entry, "{}\n");
  const stopHeartbeat = startCompatibilityHeartbeat(entry, 10);

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = (await fs.promises.stat(entry)).mtimeMs;
    const blockedUntil = Date.now() + 80;
    while (Date.now() < blockedUntil) {
      // Simulate synchronous work in the action process while the worker owns the heartbeat.
    }
    const after = (await fs.promises.stat(entry)).mtimeMs;
    assert.ok(after > before);
  } finally {
    stopHeartbeat();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("compatibility heartbeat reports a compromised lease", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-lock-compromised-"));
  const entry = path.join(root, "missing.ticket.json");
  let stopHeartbeat: (() => void) | undefined;

  try {
    const compromised = new Promise<Error>((resolve) => {
      stopHeartbeat = startCompatibilityHeartbeat(entry, 10, resolve);
    });
    const error = await compromised;
    assert.match(error.message, /heartbeat failed/);
    assert.match(error.message, /ENOENT/);
  } finally {
    stopHeartbeat?.();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("materializePrismaRuntime isolates generated clients by workspace", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-link-"));
  const runtimeDirectory = path.join(root, "runtime");
  const workspaceOne = path.join(root, "workspace-one");
  const workspaceTwo = path.join(root, "workspace-two");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = path.join(root, "runner-temp");
  await fs.promises.mkdir(path.join(runtimeDirectory, "node_modules"), { recursive: true });
  await fs.promises.writeFile(path.join(runtimeDirectory, "node_modules", "runtime-marker"), "cached");
  await fs.promises.mkdir(path.join(runtimeDirectory, "node_modules", ".prisma", "client"), {
    recursive: true
  });
  await fs.promises.writeFile(
    path.join(runtimeDirectory, "node_modules", ".prisma", "client", "cached-schema"),
    "must-not-copy"
  );
  await fs.promises.mkdir(workspaceOne, { recursive: true });
  await fs.promises.mkdir(workspaceTwo, { recursive: true });

  const runtime: PrismaRuntime = {
    version: "5.22.0",
    directory: runtimeDirectory,
    cliEntry: path.join(runtimeDirectory, "node_modules", "prisma", "build", "index.js")
  };

  try {
    const releaseWorkspaceOne = await materializePrismaRuntime(runtime, workspaceOne);
    const releaseWorkspaceTwo = await materializePrismaRuntime(runtime, workspaceTwo);

    const modulesOne = await fs.promises.realpath(path.join(workspaceOne, "node_modules"));
    const modulesTwo = await fs.promises.realpath(path.join(workspaceTwo, "node_modules"));
    assert.notEqual(modulesOne, modulesTwo);
    assert.notEqual(modulesOne, await fs.promises.realpath(path.join(runtimeDirectory, "node_modules")));
    assert.equal(await fs.promises.readFile(path.join(modulesOne, "runtime-marker"), "utf8"), "cached");
    assert.equal(fs.existsSync(path.join(modulesOne, ".prisma")), false);
    assert.equal(fs.existsSync(path.join(modulesTwo, ".prisma")), false);

    await fs.promises.mkdir(path.join(modulesOne, ".prisma", "client"), { recursive: true });
    await fs.promises.writeFile(
      path.join(modulesOne, ".prisma", "client", "schema.prisma"),
      "workspace-one"
    );
    assert.equal(fs.existsSync(path.join(modulesTwo, ".prisma", "client", "schema.prisma")), false);
    assert.equal(
      await fs.promises.readFile(
        path.join(runtimeDirectory, "node_modules", ".prisma", "client", "cached-schema"),
        "utf8"
      ),
      "must-not-copy"
    );
    await releaseWorkspaceOne();
    await releaseWorkspaceTwo();
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("materializePrismaRuntime holds the workspace lease until the caller releases it", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-concurrent-"));
  const runtimeDirectory = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = path.join(root, "runner-temp");
  await fs.promises.mkdir(path.join(runtimeDirectory, "node_modules"), { recursive: true });
  await fs.promises.writeFile(path.join(runtimeDirectory, "node_modules", "runtime-marker"), "cached");

  const runtime: PrismaRuntime = {
    version: "5.22.0",
    directory: runtimeDirectory,
    cliEntry: path.join(runtimeDirectory, "node_modules", "prisma", "build", "index.js")
  };

  try {
    const releaseFirst = await materializePrismaRuntime(runtime, workspace);
    let secondAcquired = false;
    const secondMaterialization = materializePrismaRuntime(runtime, workspace).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(secondAcquired, false);
    await releaseFirst();
    const releaseSecond = await secondMaterialization;
    const modules = await fs.promises.realpath(path.join(workspace, "node_modules"));
    assert.equal(await fs.promises.readFile(path.join(modules, "runtime-marker"), "utf8"), "cached");
    await releaseSecond();
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("materializePrismaRuntime switches managed runtimes when configuration changes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-switch-"));
  const workspace = path.join(root, "workspace");
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = path.join(root, "runner-temp");

  const createRuntime = async (version: string) => {
    const directory = path.join(root, `runtime-${version}`);
    await fs.promises.mkdir(path.join(directory, "node_modules"), { recursive: true });
    await fs.promises.writeFile(path.join(directory, "node_modules", "runtime-marker"), version);
    return {
      version,
      directory,
      cliEntry: path.join(directory, "node_modules", "prisma", "build", "index.js")
    } satisfies PrismaRuntime;
  };

  try {
    const firstRuntime = await createRuntime("5.22.0");
    const secondRuntime = await createRuntime("6.0.0");
    const releaseFirst = await materializePrismaRuntime(firstRuntime, workspace);
    const firstModules = await fs.promises.realpath(path.join(workspace, "node_modules"));
    await releaseFirst();

    const releaseSecond = await materializePrismaRuntime(secondRuntime, workspace);
    const secondModules = await fs.promises.realpath(path.join(workspace, "node_modules"));

    assert.notEqual(firstModules, secondModules);
    assert.equal(await fs.promises.readFile(path.join(firstModules, "runtime-marker"), "utf8"), "5.22.0");
    assert.equal(await fs.promises.readFile(path.join(secondModules, "runtime-marker"), "utf8"), "6.0.0");
    await releaseSecond();
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("materializePrismaRuntime validates exact versions in existing dependencies", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-version-"));
  const runtimeDirectory = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const zodDirectory = path.join(workspace, "node_modules", "zod");
  await fs.promises.mkdir(path.join(runtimeDirectory, "node_modules"), { recursive: true });
  await fs.promises.mkdir(zodDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(zodDirectory, "package.json"), '{"version":"3.25.0"}\n');

  const runtime: PrismaRuntime = {
    version: "5.22.0",
    directory: runtimeDirectory,
    cliEntry: path.join(runtimeDirectory, "node_modules", "prisma", "build", "index.js")
  };

  try {
    await assert.rejects(
      materializePrismaRuntime(runtime, workspace, { zod: "3.25.1" }),
      /must be 3\.25\.1, but found 3\.25\.0/
    );
    await fs.promises.writeFile(path.join(zodDirectory, "package.json"), '{"version":"3.25.1"}\n');
    const release = await materializePrismaRuntime(runtime, workspace, { zod: "3.25.1" });
    await release();
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("acquireWorkspaceLock safely serializes contenders after abandoned entries", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-stale-lock-"));
  const lock = path.join(root, "workspace.lock");
  await fs.promises.mkdir(lock, { recursive: true });
  const abandoned = JSON.stringify({
    pid: 99_999_999,
    token: "abandoned",
    processIdentity: "terminated-process",
    number: 1
  });
  const abandonedChoosing = path.join(lock, "abandoned.choosing.json");
  const abandonedTicket = path.join(lock, "abandoned.ticket.json");
  const recycledPidTicket = path.join(lock, "recycled-pid.ticket.json");
  await fs.promises.writeFile(abandonedChoosing, `${abandoned}\n`);
  await fs.promises.writeFile(abandonedTicket, `${abandoned}\n`);
  await fs.promises.writeFile(
    recycledPidTicket,
    `${JSON.stringify({
      pid: process.pid,
      token: "recycled-pid",
      processIdentity: "previous-process-with-same-pid",
      number: 1
    })}\n`
  );

  try {
    let acquiredCount = 0;
    const firstAcquisition = acquireWorkspaceLock(lock).then((release) => {
      acquiredCount += 1;
      return { name: "first", release };
    });
    const secondAcquisition = acquireWorkspaceLock(lock).then((release) => {
      acquiredCount += 1;
      return { name: "second", release };
    });
    const winner = await Promise.race([firstAcquisition, secondAcquisition]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(acquiredCount, 1);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.existsSync(abandonedChoosing), false);
    assert.equal(fs.existsSync(abandonedTicket), false);
    assert.equal(fs.existsSync(recycledPidTicket), false);

    await winner.release();
    const follower = await (winner.name === "first" ? secondAcquisition : firstAcquisition);
    assert.equal(acquiredCount, 2);
    await follower.release();
    assert.deepEqual(await fs.promises.readdir(lock), []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
