import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "dist-web");
const assets = resolve(dist, "assets");
const cssFiles = readdirSync(assets)
  .filter((name) => name.endsWith(".css"))
  .map((name) => resolve(assets, name));
const references = cssFiles.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/url\(["']?([^"')]*KaTeX[^"')]*)["']?\)/gu)].map((match) => ({
    file,
    url: match[1],
  })),
);

if (references.length === 0) throw new Error("built CSS contains no KaTeX font references");
for (const reference of references) {
  const target = resolve(dirname(reference.file), reference.url.split(/[?#]/u)[0]);
  if (relative(dist, target).startsWith("..") || !existsSync(target)) {
    throw new Error(`built KaTeX font is missing: ${reference.url}`);
  }
}
