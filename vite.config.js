import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/*
 * The routine is deliberately not in the repository in the clear — see
 * routine.enc — so a fresh clone has nothing to build until it is unsealed.
 * Say so plainly rather than letting the bundler report a missing import.
 */
if (!fs.existsSync(new URL("./routine.json", import.meta.url))) {
  throw new Error(
    "routine.json is missing.\n\n" +
    "If routine.enc is in the repository, unseal it with the site passphrase:\n" +
    "    node build_site.mjs --routine-only\n\n" +
    "If this is a fresh start, begin from the sample and edit it:\n" +
    "    cp routine.sample.json routine.json\n"
  );
}

/*
 * One self-contained HTML file, because build_site.mjs encrypts the build output
 * as a single blob and the unlock page writes it into the document. Nothing may
 * be fetched from a second file at runtime: there is no second file.
 *
 * The bundle is an IIFE rather than an ES module on purpose. The unlock page
 * boots the app with document.write(), and a classic script runs there in every
 * browser; a module script's timing is subtler than this needs to be.
 */
export default defineConfig({
  plugins: [react(), tailwind(), viteSingleFile()],
  build: {
    target: "es2020",
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
