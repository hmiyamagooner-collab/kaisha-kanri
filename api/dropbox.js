// /api/dropbox.js — GOONER PORTAL Dropbox連携窓口 v2（ログイン検問付き）
// 必要な環境変数:
//   DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN  (設定済み)
//   SUPABASE_URL, SUPABASE_ANON_KEY         (今回追加)
// 検問: Supabaseログイン済み かつ members.dropbox_allowed=true (または役職=社長) のみ通す

const PORTAL_ROOT = ""; // ← 検問導入により全体公開へ変更。フォルダ限定に戻す場合は "/GoonerPortal"

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
  cachedUntil = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ===== 検問所: ログイン済みか？ Dropbox許可があるか？ =====
async function checkPermission(req) {
  const authHeader = req.headers.authorization || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return { ok: false, reason: "not_logged_in" };

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_ANON_KEY;

  // 1) トークンが本物のログインか確認
  const u = await fetch(SB + "/auth/v1/user", {
    headers: { apikey: KEY, Authorization: "Bearer " + jwt },
  });
  if (!u.ok) return { ok: false, reason: "invalid_session" };
  const user = await u.json();

  // 2) 名簿で許可を確認
  const m = await fetch(
    SB + "/rest/v1/members?auth_user_id=eq." + user.id + "&select=role,dropbox_allowed",
    { headers: { apikey: KEY, Authorization: "Bearer " + jwt } }
  );
  const rows = await m.json();
  const me = rows && rows[0];
  if (!me) return { ok: false, reason: "not_registered" };
  if (me.role === "社長" || me.dropbox_allowed === true) return { ok: true };
  return { ok: false, reason: "not_allowed" };
}

function safePath(p) {
  const clean = ("/" + String(p || "")).replace(/\.\./g, "").replace(/\/+/g, "/");
  if (!PORTAL_ROOT) return clean === "/" ? "" : clean; // 全体モード(ルートは空文字)
  return clean === "/" ? PORTAL_ROOT : PORTAL_ROOT + clean;
}

export default async function handler(req, res) {
  try {
    // ---- 検問 ----
    const gate = await checkPermission(req);
    if (!gate.ok) {
      const msg = {
        not_logged_in: "ログインが必要です",
        invalid_session: "セッションが無効です。再ログインしてください",
        not_registered: "名簿に登録がありません",
        not_allowed: "Dropbox閲覧の許可がありません。社長に許可を依頼してください",
      }[gate.reason] || "権限がありません";
      return res.status(403).json({ error: msg, reason: gate.reason });
    }

    const token = await getAccessToken();
    const action = (req.method === "GET" ? req.query.action : req.body?.action) || "list";

    if (action === "list") {
      const r = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ path: safePath(req.query.path) }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data });
      return res.status(200).json({
        entries: (data.entries || []).map(e => ({
          type: e[".tag"], name: e.name, path: e.path_display,
          size: e.size || null, modified: e.server_modified || null,
        })),
      });
    }

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
