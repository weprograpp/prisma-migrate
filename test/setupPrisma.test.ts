import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  loadPrismaRuntime,
  materializePrismaRuntime,
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

test("materializePrismaRuntime links dependencies", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prisma-runtime-link-"));
  const runtimeDirectory = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  await fs.promises.mkdir(path.join(runtimeDirectory, "node_modules"), { recursive: true });
  await fs.promises.mkdir(workspace, { recursive: true });

  const runtime: PrismaRuntime = {
    version: "5.22.0",
    directory: runtimeDirectory,
    cliEntry: path.join(runtimeDirectory, "node_modules", "prisma", "build", "index.js")
  };

  await materializePrismaRuntime(runtime, workspace);
  assert.equal(
    await fs.promises.realpath(path.join(workspace, "node_modules")),
    await fs.promises.realpath(path.join(runtimeDirectory, "node_modules"))
  );
  await fs.promises.rm(root, { recursive: true, force: true });
});
