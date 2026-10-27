/**
 * OrcaVerify Text 1.0（OrcaRouter，OpenAI 兼容）AIGC 检测 CLI —— 零依赖
 * 用法：node scripts/orca-aigc.mjs <文件...>          （每个文件取前 --max 字，默认 2000）
 *       node scripts/orca-aigc.mjs --text "正文"
 *       可选：--paid（用付费模型 orca/orcaverify-text1.0；默认免费 -free）  --max 2000
 * 凭据：projects/.env 的 ORCAROUTER_API_KEY（不打印）
 * 记录：projects/.aidetect/orca-detections.ndjson（含输入 sha256，不含正文与密钥）
 * 返回字段：verdict（AI_GENERATED/AI_ASSISTED/HUMAN/ABSTAIN）、aiProb（0–1）、threshold、paragraphs、raw
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of fs.readFileSync(path.join(root, "projects", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const KEY = process.env.ORCAROUTER_API_KEY ?? env.ORCAROUTER_API_KEY;
if (!KEY) throw new Error("projects/.env 缺 ORCAROUTER_API_KEY");

const ENDPOINT = "https://api.orcarouter.ai/v1/chat/completions";
export const MODEL_FREE = "orca/orcaverify-text1.0-free";
export const MODEL_PAID = "orca/orcaverify-text1.0";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从助手回复里抽出：首行结论 + ``` 围栏 JSON。字段名未公开固定，按常见别名宽松取值。
export function parseOrca(content) {
  const out = { verdict: null, aiProb: null, threshold: null, paragraphs: null, json: null };
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { out.json = JSON.parse(m[1]); } catch { /* 留 raw */ } }
  const j = out.json ?? {};
  const pick = (...ks) => { for (const k of ks) if (j[k] !== undefined) return j[k]; return undefined; };
  const v = pick("verdict", "label", "classification", "decision", "result");
  out.verdict = typeof v === "string" ? v.toUpperCase() : (content.match(/\b(AI_GENERATED|AI_ASSISTED|HUMAN|ABSTAIN)\b/) ?? [])[1] ?? null;
  // 实测字段（model_version text_ai-0.5.0-chinese）：p_calibrated；ABSTAIN 时为 null，概率只在 abstain.detail「P(has AI)=73.7%」里
  const p = pick("p_calibrated", "ai_probability", "probability", "p_ai");
  if (typeof p === "number") out.aiProb = p > 1 ? p / 100 : p;
  else {
    const d = String(j.abstain?.detail ?? content).match(/P\(has AI\)=([\d.]+)%/);
    out.aiProb = d ? +d[1] / 100 : null;
  }
  out.abstainReason = j.abstain?.reason ?? null;
  out.threshold = pick("thresholds", "threshold") ?? null;
  out.band = j.ai_involvement?.band ?? null;
  const pl = j.paragraph_localization?.paragraphs;
  out.paragraphs = Array.isArray(pl) ? pl.map((x) => ({ s: x.start, e: x.end, p: x.p, f: x.flagged })) : null;
  out.modelVersion = j.model_version ?? null;
  return out;
}

export async function orcaAigc(text, { paid = false, retries = 3 } = {}) {
  const model = paid ? MODEL_PAID : MODEL_FREE;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const bodyText = await res.text();
    let body; try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText.slice(0, 300) }; }
    const errCode = body?.error?.code ?? body?.error?.type ?? null;
    try {
      fs.appendFileSync(path.join(root, "projects", ".aidetect", "orca-calls.ndjson"),
        JSON.stringify({ at: new Date().toISOString(), model, chars: text.length, http: res.status, err: errCode, usage: body?.usage ?? null }) + "\n", "utf8");
    } catch {}
    // 429 限速可重试（免费档 5 rpm）；400 prompt cap 重试无效
    if (res.status === 429 && attempt < retries && errCode !== "err_free_access_denied") { await sleep(15_000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${errCode ?? ""} ${body?.error?.message ?? body.raw ?? ""}`.trim());
    const content = body?.choices?.[0]?.message?.content ?? "";
    const { json, ...parsed } = parseOrca(content); // 不回传整段 raw/json，避免日志与上下文膨胀
    return { model, ...parsed, usage: body?.usage ?? null };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const optv = (k, d) => { const i = args.indexOf(k); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } return d; };
  const paid = flag("--paid");
  const max = Number(optv("--max", 2000));
  const inputs = args[0] === "--text" ? [["(inline)", args.slice(1).join(" ")]] : args.map((f) => [f, fs.readFileSync(f, "utf8")]);
  if (!inputs.length) { console.error("用法：node scripts/orca-aigc.mjs [--paid] [--max 2000] <文件...> | --text 正文"); process.exit(2); }
  fs.mkdirSync(path.join(root, "projects", ".aidetect"), { recursive: true });
  for (const [name, raw] of inputs) {
    const text = raw.replace(/^\uFEFF/, "").trim().slice(0, max);
    const out = { at: new Date().toISOString(), file: name, chars: text.length, sha256: sha(text) };
    try { Object.assign(out, await orcaAigc(text, { paid })); } catch (e) { out.error = String(e.message ?? e); }
    fs.appendFileSync(path.join(root, "projects", ".aidetect", "orca-detections.ndjson"), JSON.stringify(out) + "\n", "utf8");
    console.log(JSON.stringify(out));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
