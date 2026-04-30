import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/model.ts", "src/tools/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  unbundle: true,
  exports: false,
});
