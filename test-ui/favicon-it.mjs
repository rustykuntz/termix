import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { serveStatic } = require("../src/static.js");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "public/index.html"), "utf8");
const svg = readFileSync(join(root, "public/favicon.svg"), "utf8");
let passed = 0;

function ok(label, value) {
  if (!value) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

ok("blank data favicon is gone", !html.includes('rel="icon" href="data:,"'));
ok("SVG favicon has standard metadata", /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any">/.test(html));
ok("Apple touch icon declares its native size", /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/.test(html));
ok("favicon uses the shipped brand gradient", svg.includes("#e18063") && svg.includes("#c25a3c"));
ok("favicon has a compact terminal glyph", svg.includes("9.5 9.5 6.5 6.5") && svg.includes("17.5 22.5h5"));

const server = createServer(serveStatic);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const icon = await fetch(`${origin}/favicon.svg`);
  ok("SVG favicon serves with its correct MIME type", icon.status === 200 && icon.headers.get("content-type") === "image/svg+xml");
  ok("served SVG is the checked master asset", (await icon.text()) === svg);

  const touch = await fetch(`${origin}/apple-touch-icon.png`);
  const touchBytes = new Uint8Array(await touch.arrayBuffer());
  ok("Apple touch icon serves as a real PNG", touch.status === 200
    && touch.headers.get("content-type") === "image/png"
    && touchBytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`${passed} favicon UI assertions passed`);
