import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";

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
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function resolvePrisma(versionInput: string) {
  // Accept exact versions or "latest"
  if (!versionInput || versionInput === "latest") {
    const meta = await fetchJson<NpmMeta>("https://registry.npmjs.org/prisma");
    const v = meta["dist-tags"]["latest"];
    const tarball = meta.versions[v].dist.tarball;
    return { version: v, tarball };
  }

  // exact version
  const meta = await fetchJson<NpmMeta>("https://registry.npmjs.org/prisma");
  const v = versionInput in meta.versions ? versionInput : meta["dist-tags"][versionInput] ?? null;
  if (!v) throw new Error(`Could not resolve prisma version: ${versionInput}`);
  const tarball = meta.versions[v].dist.tarball;
  return { version: v, tarball };
}

export async function ensurePrismaCli(versionInput: string) {
  const resolved = await resolvePrisma(versionInput);
  const found = tc.find("prisma-cli-npm", resolved.version);
  if (found) {
    core.info(`Prisma CLI cache hit: ${resolved.version}`);
    return path.join(found, "package", "build", "index.js");
  }

  core.info(`Downloading Prisma CLI ${resolved.version}…`);
  const tgz = await tc.downloadTool(resolved.tarball);
  const extracted = await tc.extractTar(tgz);
  const cachedDir = await tc.cacheDir(extracted, "prisma-cli-npm", resolved.version);

  // Return the path to the CLI entry (bin points to build/index.js)
  const cliEntry = path.join(cachedDir, "package", "build", "index.js");
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`Prisma CLI entry not found at ${cliEntry}`);
  }

  core.addPath(path.dirname(cliEntry)); // not strictly needed but handy
  return cliEntry;
}
