import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "node:path";
import { ensurePrismaCli } from "./setupPrisma";

type Result = {
  databaseUrlMasked: string;
  ok: boolean;
  exitCode: number;
  ms: number;
};

function parseDbUrls(raw: string): string[] {
  const trimmed = (raw || "").trim();
  if (!trimmed) return [];
  // JSON array?
  if (trimmed.startsWith("["))
    return JSON.parse(trimmed).map((s: string) => String(s).trim()).filter(Boolean);

  // newline / comma separated
  return trimmed
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function maskUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return "***";
  }
}

async function run() {
  try {
    const prismaVersion = core.getInput("prisma-version");
    const databaseUrls = parseDbUrls(core.getInput("database-urls"));
    const schema = core.getInput("schema") || "prisma/schema.prisma";
    const prismaArgs = core.getInput("prisma-args") || "";
    const failFast = /^true$/i.test(core.getInput("fail-fast") || "true");
    const cwd = core.getInput("working-directory") || ".";

    if (databaseUrls.length === 0) {
      core.setFailed("No database URLs provided.");
      return;
    }

    // redacts
    for (const u of databaseUrls) core.setSecret(u);

    // 1) Ensure Prisma CLI is available (cached)
    const cliEntry = await ensurePrismaCli(prismaVersion);

    const results: Result[] = [];

    // 2) Sanity: show versions (also triggers engines download on first run)
    await exec.exec("node", [cliEntry, "--version"]);

    // 3) Iterate DBs sequentially
    for (const dbUrl of databaseUrls) {
      const masked = maskUrl(dbUrl);
      core.startGroup(`Migrate: ${masked}`);
      const start = Date.now();

      let exitCode = 0;
      try {
        const args = ["migrate", "deploy", "--schema", path.resolve(cwd, schema)];
        if (prismaArgs.trim()) {
          // cautious split: allow user to pass `--force --something="a b"`
          args.push(...prismaArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []);
        }

        exitCode = await exec.exec(
          "node",
          [cliEntry, ...args],
          {
            cwd,
            env: {
              ...process.env,
              DATABASE_URL: dbUrl,
              PRISMA_HIDE_UPDATE_MESSAGE: "1"
            },
            ignoreReturnCode: true
          }
        );

        const ok = exitCode === 0;
        results.push({ databaseUrlMasked: masked, ok, exitCode, ms: Date.now() - start });

        if (!ok) {
          core.error(`Migration failed for ${masked} (exit ${exitCode}).`);
          if (failFast) {
            core.endGroup();
            break;
          }
        } else {
          core.info(`Migration OK for ${masked}.`);
        }
      } finally {
        core.endGroup();
      }
    }

    const anyFail = results.some((r) => !r.ok);
    core.setOutput("results", JSON.stringify(results));
    if (anyFail) {
      core.setFailed("One or more database migrations failed. See logs above.");
    }
  } catch (err: any) {
    core.setFailed(err?.message ?? String(err));
  }
}

run();