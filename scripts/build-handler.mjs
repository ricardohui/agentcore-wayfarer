// Bundles only our own source (fastify/avvio, pulled in transitively by
// bedrock-agentcore, use dynamic `require()` calls that esbuild cannot
// resolve when fully bundled to a single ESM file) and vendors the real
// npm dependencies as node_modules/, per AgentCore's documented Node.js
// direct-code-deploy packaging option.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";

const OUT_DIR = "dist/concierge";
const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8"));

// Pin to the exact version already installed (and tested) at the repo root,
// rather than re-declaring version ranges here that can drift from package.json.
const runtimeDependencies = Object.fromEntries(
  Object.keys(rootPackageJson.dependencies).map((name) => [
    name,
    JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version,
  ]),
);

await esbuild.build({
  entryPoints: ["src/concierge/infra/handler.ts"],
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

// Browser Tool's price-check (issue #19) pulls in "playwright" for its
// PlaywrightBrowser.connectOverCDP — the deployed bundle only ever connects
// to AgentCore's remote Browser Tool session, never launches a local
// browser, so downloading Playwright's local browser binaries here would be
// pure waste (and a slow, unnecessary step in every deploy).
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], {
  cwd: OUT_DIR,
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});
