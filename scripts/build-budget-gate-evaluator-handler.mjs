// The budget-gate evaluator Lambda (issue #23) has zero third-party runtime
// dependencies (pure span parsing), so it bundles to one self-contained CJS
// file — same shape as build-booking-gateway-handler.mjs.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/evaluations/budget-gate-evaluator/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/evaluations/budget-gate-evaluator/app.js",
});
