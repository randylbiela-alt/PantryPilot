import { promises as fs } from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
if (!roots.length) throw new Error("Provide one or more repository roots.");

const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".css", ".html", ".yml", ".yaml"]);
const ignored = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".pantrypilot-backups"]);
const literalReplacements = [
  ["Ãƒâ€šÃ‚Â·", " | "], ["Ãƒâ€šÃ‚·", " | "], ["Ã‚Â·", " | "], ["Â·", " | "],
  ["ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â¢", " | "], ["â€¢", " | "], ["•", " | "], ["·", " | "],
  ["ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â¢", " | "], ["ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“", " - "], ["ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â", " - "],
  ["â€“", "-"], ["â€”", "-"], ["–", "-"], ["—", "-"], ["…", "..."],
  ["“", "\""], ["”", "\""], ["‘", "'"], ["’", "'"],
  ["®", "(R)"], ["©", "(C)"], ["™", "(TM)"], [" ", " "], ["ï»¿", ""]
];

async function filesUnder(root) {
  const output = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const location = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(location);
      else if (extensions.has(path.extname(entry.name).toLowerCase())) output.push(location);
    }
  }
  await walk(root);
  return output;
}

let filesChanged = 0;
let replacements = 0;
for (const root of roots) {
  for (const file of await filesUnder(root)) {
    let text = await fs.readFile(file, "utf8");
    const original = text;
    for (const [bad, good] of literalReplacements) {
      if (text.includes(bad)) {
        const count = text.split(bad).length - 1;
        text = text.split(bad).join(good);
        replacements += count;
      }
    }
    text = text.replace(/[ \t]+\|[ \t]+/g, " | ");
    text = text.replace(/ {2,}/g, " ");
    if (text !== original) {
      await fs.writeFile(file, text, "utf8");
      filesChanged += 1;
      console.log(`Sanitized: ${file}`);
    }
  }
}
console.log(`ASCII sanitation complete. Files changed: ${filesChanged}. Replacements: ${replacements}.`);
