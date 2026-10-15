#!/usr/bin/env node
// Print the IIIF Auth 2.0 service block for one content resource.
//
//   node scripts/service-block.mjs <base-url> <collection> <path> <collection-config.json>
//
// <collection-config.json> holds one collection's config object (the value
// under COLLECTIONS.<collection> in wrangler.jsonc, as plain JSON).
// Needs Node >= 22.18 (runs the TypeScript source directly).
import { readFileSync } from "node:fs";
import { serviceBlock } from "../src/iiif.ts";

const [base, collection, path, configFile] = process.argv.slice(2);
if (!base || !collection || !path || !configFile) {
  console.error("usage: service-block.mjs <base-url> <collection> <path> <collection-config.json>");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configFile, "utf8"));
console.log(JSON.stringify(serviceBlock(base, collection, path, config), null, 2));
