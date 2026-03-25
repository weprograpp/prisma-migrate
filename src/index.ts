import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "node:path";
import { ensurePrismaCli } from "./setupPrisma";

type PrismaOperation = "generate" | "migrate" | "seed";

type Result = {
  operation: PrismaOperation;
  databaseUrlMasked?: string;
  ok: boolean;
  exitCode: number;
  ms: number;
};

function getInput(name: string): string {
  const normalized = name.replace(/ /g, "_").toUpperCase();
  return (
    process.env[`INPUT_${normalized}`] ??
    process.env[`INPUT_${normalized.replace(/-/g, "_")}`] ??
    ""
  ).trim();
}

function parseList(raw: string): string[] {
  const trimmed = (raw || "").trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
        .map((value: unknown) => String(value).trim())
        .filter(Boolean);
    } catch {
      // Fall through to line/comma parsing.
    }
  }

  return trimmed
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = getInput(name);
  if (!raw) return defaultValue;
  return /^(true|1|yes|y|on)$/i.test(raw);
}

function maskUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return "***";
  }
}

function collectDatabaseUrls(): string[] {
  return [...parseList(getInput("database-url")), ...parseList(getInput("database-urls"))];
}

async function runPrismaCommand(options: {
  cliEntry: string;
  cwd: string;
  operation: PrismaOperation;
  args: string[];
  databaseUrl?: string;
}): Promise<Result> {
  const { cliEntry, cwd, operation, args, databaseUrl } = options;
  const masked = databaseUrl ? maskUrl(databaseUrl) : undefined;
  const start = Date.now();

  core.startGroup(`${operation[0].toUpperCase()}${operation.slice(1)}${masked ? `: ${masked}` : ""}`);

  try {
    const env: Record<string, string> = {
      PRISMA_HIDE_UPDATE_MESSAGE: "1"
    };

    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }

    if (databaseUrl) {
      env.DATABASE_URL = databaseUrl;
    }

    const exitCode = await exec.exec("node", [cliEntry, ...args], {
      cwd,
      env,
      ignoreReturnCode: true
    });

    const ok = exitCode === 0;
    if (!ok) {
      core.error(`${operation} failed${masked ? ` for ${masked}` : ""} (exit ${exitCode}).`);
    } else {
      core.info(`${operation} completed${masked ? ` for ${masked}` : ""}.`);
    }

    return { operation, databaseUrlMasked: masked, ok, exitCode, ms: Date.now() - start };
  } finally {
    core.endGroup();
  }
}

async function run() {
  try {
    const prismaVersion = getInput("prisma-version") || "5.22.0";
    const schema = getInput("schema") || "prisma/schema.prisma";
    const cwd = getInput("working-directory") || ".";
    const prismaArgs = getInput("prisma-args") || "";
    const failFast = parseBooleanInput("fail-fast", true);
    const runGenerate = parseBooleanInput("generate", false);
    const runMigrate = parseBooleanInput("migrate", true);
    const runSeed = parseBooleanInput("seed", false);
    const databaseUrls = collectDatabaseUrls();

    if (!runGenerate && !runMigrate && !runSeed) {
      core.setFailed("At least one of generate, migrate, or seed must be enabled.");
      return;
    }

    if ((runMigrate || runSeed) && databaseUrls.length === 0) {
      core.setFailed("A database URL is required when migrate or seed is enabled.");
      return;
    }

    for (const databaseUrl of databaseUrls) {
      core.setSecret(databaseUrl);
    }

    const cliEntry = await ensurePrismaCli(prismaVersion);
    const results: Result[] = [];

    await exec.exec("node", [cliEntry, "--version"]);

    const firstDatabaseUrl = databaseUrls[0];

    if (runGenerate) {
      const generateResult = await runPrismaCommand({
        cliEntry,
        cwd,
        operation: "generate",
        args: ["generate", "--schema", path.resolve(cwd, schema)],
        databaseUrl: firstDatabaseUrl
      });
      results.push(generateResult);

      if (!generateResult.ok) {
        core.setOutput("results", JSON.stringify(results));
        core.setFailed("Prisma generate failed. See logs above.");
        return;
      }
    }

    if (runMigrate || runSeed) {
      for (const databaseUrl of databaseUrls) {
        let migrateSucceeded = true;

        if (runMigrate) {
          const migrateArgs = ["migrate", "deploy", "--schema", path.resolve(cwd, schema)];
          if (prismaArgs.trim()) {
            migrateArgs.push(...prismaArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []);
          }

          const migrateResult = await runPrismaCommand({
            cliEntry,
            cwd,
            operation: "migrate",
            args: migrateArgs,
            databaseUrl
          });
          results.push(migrateResult);
          migrateSucceeded = migrateResult.ok;

          if (!migrateResult.ok) {
            if (failFast) {
              core.setOutput("results", JSON.stringify(results));
              core.setFailed("One or more Prisma migrations failed. See logs above.");
              return;
            }
          }
        }

        if (runSeed && migrateSucceeded) {
          const seedResult = await runPrismaCommand({
            cliEntry,
            cwd,
            operation: "seed",
            args: ["db", "seed"],
            databaseUrl
          });
          results.push(seedResult);

          if (!seedResult.ok && failFast) {
            core.setOutput("results", JSON.stringify(results));
            core.setFailed("One or more Prisma seeds failed. See logs above.");
            return;
          }
        }
      }
    }

    const anyFail = results.some((result) => !result.ok);
    core.setOutput("results", JSON.stringify(results));

    if (anyFail) {
      core.setFailed("One or more Prisma operations failed. See logs above.");
    }
  } catch (err: any) {
    core.setFailed(err?.message ?? String(err));
  }
}

run();
