/**
 * 腾讯云 TMS TextModeration（Type=TEXT_AIGC）本地检测 CLI —— 零依赖，自带 TC3-HMAC-SHA256 签名
 * 用法：node scripts/tms-aigc.mjs <文件...>      （每个文件取前 2000 字）
 *       node scripts/tms-aigc.mjs --text "正文"
 * 凭据：projects/.env 的 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY / TENCENTCLOUD_REGION
 * 记录：projects/.aidetect/tms-detections.ndjson（含输入 sha256，不含密钥）
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
const SID = process.env.TENCENTCLOUD_SECRET_ID ?? env.TENCENTCLOUD_SECRET_ID;
const SKEY = process.env.TENCENTCLOUD_SECRET_KEY ?? env.TENCENTCLOUD_SECRET_KEY;
const REGION = process.env.TENCENTCLOUD_REGION ?? env.TENCENTCLOUD_REGION ?? "ap-guangzhou";
const BIZTYPE = process.env.TMS_BIZTYPE ?? "aigc_text_detect_100053286361";
if (!SID || !SKEY) throw new Error("projects/.env 缺 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY");

const HOST = "tms.tencentcloudapi.com";
const sha256 = (s, enc = "hex") => crypto.createHash("sha256").update(s).digest(enc);
const hmac = (k, s, enc) => crypto.createHmac("sha256", k).update(s).digest(enc);

export async function tmsAigc(text, dataId) {
  const payload = JSON.stringify({
    Content: Buffer.from(text, "utf8").toString("base64"),
    Type: "TEXT_AIGC",
    BizType: BIZTYPE,
    ...(dataId ? { DataId: dataId } : {}),
  });
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const canonical = ["POST", "/", "", `content-type:application/json; charset=utf-8\nhost:${HOST}\n`, "content-type;host", sha256(payload)].join("\n");
  const scope = `${date}/tms/tc3_request`;
  const toSign = ["TC3-HMAC-SHA256", ts, scope, sha256(canonical)].join("\n");
  const kSign = hmac(hmac(hmac("TC3" + SKEY, date), "tms"), "tc3_request");
  const auth = `TC3-HMAC-SHA256 Credential=${SID}/${scope}, SignedHeaders=content-type;host, Signature=${hmac(kSign, toSign, "hex")}`;
  const res = await fetch(`https://${HOST}`, {
    method: "POST",
    headers: {
      Authorization: auth, "Content-Type": "application/json; charset=utf-8", Host: HOST,
      "X-TC-Action": "TextModeration", "X-TC-Version": "2020-12-29", "X-TC-Timestamp": String(ts), "X-TC-Region": REGION,
    },
    body: payload,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json();
  const r = body.Response ?? {};
  // 计量：每次真实调用追加一行（不含正文与密钥），供成本核算
  try { fs.appendFileSync(path.join(root, "projects", ".aidetect", "tms-calls.ndjson"), JSON.stringify({ at: new Date().toISOString(), chars: text.length, ok: !r.Error, s: r.Suggestion, sc: r.Score }) + "\n", "utf8"); } catch {}
  if (r.Error) throw new Error(`${r.Error.Code}: ${r.Error.Message}`);
  return {
    suggestion: r.Suggestion, label: r.Label, subLabel: r.SubLabel, score: r.Score, bizType: r.BizType,
    detail: (r.DetailResults ?? []).map((d) => ({ label: d.Label, suggestion: d.Suggestion, score: d.Score, subLabel: d.SubLabel })),
    requestId: r.RequestId,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inputs = args[0] === "--text" ? [["(inline)", args.slice(1).join(" ")]] : args.map((f) => [f, fs.readFileSync(f, "utf8")]);
  if (!inputs.length) { console.error("用法：node scripts/tms-aigc.mjs <文件...> | --text 正文"); process.exit(2); }
  const logDir = path.join(root, "projects", ".aidetect");
  fs.mkdirSync(logDir, { recursive: true });
  for (const [name, raw] of inputs) {
    const text = raw.replace(/^\uFEFF/, "").trim().slice(0, 2000);
    const out = { at: new Date().toISOString(), file: name, chars: text.length, sha256: sha256(text).slice(0, 16) };
    try { Object.assign(out, await tmsAigc(text)); } catch (e) { out.error = String(e.message ?? e); }
    fs.appendFileSync(path.join(logDir, "tms-detections.ndjson"), JSON.stringify(out) + "\n", "utf8");
    console.log(JSON.stringify(out));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
