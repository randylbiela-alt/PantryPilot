import { promises as fs } from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
if (!roots.length) throw new Error("Provide one or more repository roots.");
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".css", ".html", ".yml", ".yaml"]);
const ignored = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".pantrypilot-backups"]);
const mojibake = ["Ã", "Â", "â€", "â€“", "â€”", "ï»¿", "�"];
const violations = [];

async function walk(current) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const location = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(location);
    else if (extensions.has(path.extname(entry.name).toLowerCase())) {
      const lines = (await fs.readFile(location, "utf8")).split(/\r?\n/);
      lines.forEach((line, index) => {
        const nonAscii = [...line].filter(char => char.codePointAt(0) > 127);
        const markers = mojibake.filter(marker => line.includes(marker));
        if (nonAscii.length || markers.length) violations.push({ file: location, line: index + 1, nonAscii: [...new Set(nonAscii)], markers });
      });
    }
  }
}
for (const root of roots) await walk(root);
if (violations.length) {
  console.error("ASCII validation failed:");
  for (const item of violations.slice(0, 200)) console.error(`${item.file}:${item.line} nonASCII=${item.nonAscii.join("")} markers=${item.markers.join(",")}`);
  if (violations.length > 200) console.error(`Additional violations: ${violations.length - 200}`);
  process.exit(1);
}
console.log("ASCII validation passed. No non-ASCII or mojibake text was found.");
