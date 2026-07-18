// /api/dropbox.js — GOONER PORTAL Dropbox連携窓口
// 認証方式: PKCE (Secret不要)。必要な環境変数: DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN
// 安全設計: 操作範囲を PORTAL_ROOT 配下に限定（Dropbox全体には触れない）

const PORTAL_ROOT = "/GoonerPortal"; // ←同期対象フォルダ。Dropbox内のフォルダ名に合わせて変更可

let cachedToken = null;
let cachedUntil = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("token_refresh_failed: " + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedUntil = Date.now() + (data.expires_in - 60) * 1000; // 期限1分前まで再利用
  return cachedToken;
}

// パスを必ずPORTAL_ROOT配下に丸める（ディレクトリ遡り対策込み）
function safePath(p) {
  const clean = ("/" + String(p || "")).replace(/\.\./g, "").replace(/\/+/g, "/");
  return clean === "/" ? PORTAL_ROOT : PORTAL_ROOT + clean;
}

export default async function handler(req, res) {
  try {
    const token = await getAccessToken();
    const action = (req.method === "GET" ? req.query.action : req.body?.action) || "list";

    // ---- 一覧 ----
    if (action === "list") {
      const r = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path: safePath(req.query.path) === PORTAL_ROOT && !req.query.path ? PORTAL_ROOT : safePath(req.query.path) }),
      });
      const data = await r.json();
      if (!r.ok) {
        // フォルダ未作成なら自動作成して空を返す
        if (JSON.stringify(data).includes("not_found")) {
          await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
            method: "POST",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ path: PORTAL_ROOT }),
          });
          return res.status(200).json({ entries: [] });
        }
        return res.status(500).json({ error: data });
      }
      return res.status(200).json({
        entries: (data.entries || []).map(e => ({
          type: e[".tag"], name: e.name, path: e.path_display,
          size: e.size || null, modified: e.server_modified || null,
        })),
      });
    }

    // ---- ダウンロード（base64で返す）----
    if (action === "download") {
      const r = await fetch("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Dropbox-API-Arg": JSON.stringify({ path: safePath(req.query.path) }),
        },
      });
      if (!r.ok) return res.status(500).json({ error: await r.text() });
      const buf = Buffer.from(await r.arrayBuffer());
      return res.status(200).json({ name: req.query.path.split("/").pop(), base64: buf.toString("base64") });
    }

    // ---- アップロード（POST: { action:"upload", path, base64 }）----
    if (action === "upload" && req.method === "POST") {
      const { path, base64 } = req.body;
      if (!path || !base64) return res.status(400).json({ error: "path and base64 required" });
      const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Dropbox-API-Arg": JSON.stringify({ path: safePath(path), mode: "add", autorename: true }),
          "Content-Type": "application/octet-stream",
        },
        body: Buffer.from(base64, "base64"),
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data });
      return res.status(200).json({ ok: true, path: data.path_display, name: data.name });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
