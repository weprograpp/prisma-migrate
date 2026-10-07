import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  loadPrismaRuntime,
  materializePrismaRuntime,
  parseRuntimeDependencies,
  resolveVersion,
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
    await materializePrismaRuntime(runtime, workspaceOne);
    await materializePrismaRuntime(runtime, workspaceTwo);

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
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("materializePrismaRuntime serializes concurrent preparation for one workspace", async () => {
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
    await Promise.all([
      materializePrismaRuntime(runtime, workspace),
      materializePrismaRuntime(runtime, workspace)
    ]);
    const modules = await fs.promises.realpath(path.join(workspace, "node_modules"));
    assert.equal(await fs.promises.readFile(path.join(modules, "runtime-marker"), "utf8"), "cached");
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
    await materializePrismaRuntime(firstRuntime, workspace);
    const firstModules = await fs.promises.realpath(path.join(workspace, "node_modules"));

    await materializePrismaRuntime(secondRuntime, workspace);
    const secondModules = await fs.promises.realpath(path.join(workspace, "node_modules"));

    assert.notEqual(firstModules, secondModules);
    assert.equal(await fs.promises.readFile(path.join(firstModules, "runtime-marker"), "utf8"), "5.22.0");
    assert.equal(await fs.promises.readFile(path.join(secondModules, "runtime-marker"), "utf8"), "6.0.0");
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
    await materializePrismaRuntime(runtime, workspace, { zod: "3.25.1" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
