// The router Lambda has zero third-party runtime dependencies (mock data
// generation only), so it bundles to one self-contained CJS file — no
// vendored node_modules/ needed, unlike the Concierge's bundle.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/booking-gateway/infra/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/booking-gateway/app.js",
});
