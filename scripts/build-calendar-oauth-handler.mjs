// jose ships ESM-only, so — same as the Concierge's own bundle — this
// vendors its real npm dependencies as node_modules/ rather than fully
// bundling them, per AgentCore-adjacent Lambda's ESM packaging needs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const OUT_DIR = "dist/calendar-oauth-server";
const RUNTIME_DEPENDENCY_NAMES = [
  "jose",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/lib-dynamodb",
  "@aws-sdk/client-secrets-manager",
];

// Pin to the exact version already installed (and tested) at the repo root,
// rather than re-declaring version ranges here that can drift from package.json.
const runtimeDependencies = Object.fromEntries(
  RUNTIME_DEPENDENCY_NAMES.map((name) => [
    name,
    JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version,
  ]),
);

await esbuild.build({
  entryPoints: ["src/calendar-oauth-server/infra/handler.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: `${OUT_DIR}/app.js`,
});

writeFileSync(
  `${OUT_DIR}/package.json`,
  JSON.stringify({ type: "module", dependencies: runtimeDependencies }, null, 2),
);

execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], {
  cwd: OUT_DIR,
  stdio: "inherit",
});
