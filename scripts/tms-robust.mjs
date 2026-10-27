/**
 * 扰动一致性检测（2026-09-30 实测动机）：
 *   单次 TMS 读数可被纯排版刷翻 —— 只把直引号 " 换成 “” 就让 4/4 篇 Block/Review → Pass/0，
 *   vendor 改错词（掌心→牢笼）也能 Block/99 → Pass/0。所以单次 Pass 不能当"更像人"的证据。
 * 做法：对同一正文生成若干「语义完全相同、只改排版」的变体，各测一次，取最坏值。
 *   robustPass = 所有变体都 Pass。
 * 用法：node scripts/tms-robust.mjs <文件...> [--json]
 * 导出：robust(text) → { worst, variants:[{name,suggestion,score}], robustPass }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmsAigc } from "./tms-aigc.mjs";

function pairQuotes(t, open, close) {
  let depth = 0;
  return t.replace(/[“”「」"]/g, (q) => {
    if (q === "“" || q === "「") { depth = 1; return open; }
    if (q === "”" || q === "」") { depth = 0; return close; }
    depth ^= 1; return depth ? open : close; // 直引号交替
  });
}
export const VARIANTS = {
  asis: (t) => t,
  curly: (t) => pairQuotes(t, "“", "”"),
  straight: (t) => pairQuotes(t, '"', '"'),
  corner: (t) => pairQuotes(t, "「", "」"),
};

const rankOf = { Pass: 0, Review: 1, Block: 2 };
export async function robust(raw) {
  const text = raw.replace(/^\uFEFF/, "").trim().slice(0, 2000);
  const seen = new Set(), real = [];
  for (const [name, fn] of Object.entries(VARIANTS)) {
    const v = fn(text);
    if (seen.has(v)) continue; // 与已测变体逐字相同，不重复计费
    seen.add(v);
    const r = await tmsAigc(v);
    real.push({ name, suggestion: r.suggestion, score: r.score });
  }
  const worst = real.reduce((w, v) => (rankOf[v.suggestion] > rankOf[w.suggestion] || (rankOf[v.suggestion] === rankOf[w.suggestion] && v.score > w.score) ? v : w), real[0]);
  return { worst: `${worst.suggestion}/${worst.score}`, worstScore: worst.suggestion === "Pass" ? 0 : worst.score, robustPass: real.every((v) => v.suggestion === "Pass"), variants: real.map(({ name, suggestion, score }) => ({ name, suggestion, score })), calls: real.length };
}

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const asJson = process.argv.includes("--json");
  const out = [];
  for (const f of files) {
    const r = await robust(fs.readFileSync(f, "utf8"));
    out.push({ file: path.basename(f), ...r });
    if (!asJson) console.log(`${path.basename(f).padEnd(24)} worst ${r.worst.padEnd(10)} robustPass=${r.robustPass}  ${r.variants.map((v) => `${v.name}:${v.suggestion}/${v.score}`).join(" ")}`);
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
