// /api/attendance — 出勤チェックイン記録（Dropbox）
// POST { action:'checkin', name, email, role, date?, memberId? }
// 環境変数: DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN

const ATT_DIR = "/GoonerPortal/_portal/attendance";

let cachedToken = null;
let cachedUntil = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN || "",
      client_id: process.env.DROPBOX_APP_KEY || "",
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("token_refresh_failed: " + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedUntil = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function todayJst() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

async function downloadJson(token, path) {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (res.status === 409) return null;
  if (!res.ok) {
    const t = await res.text();
    if (/not_found|path\/not_found/i.test(t)) return null;
    throw new Error("download_failed: " + t.slice(0, 200));
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function uploadJson(token, path, obj) {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "overwrite",
        autorename: false,
        mute: true,
      }),
    },
    body: Buffer.from(JSON.stringify(obj, null, 2), "utf8"),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("upload_failed: " + t.slice(0, 300));
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.DROPBOX_REFRESH_TOKEN || !process.env.DROPBOX_APP_KEY) {
    console.log("[attendance]", JSON.stringify(req.body || {}));
    return res.status(200).json({
      ok: true,
      stored: "log-only",
      hint: "DROPBOX_* 未設定のためサーバーログのみ記録しました",
    });
  }
  try {
    const body = req.body || {};
    const action = String(body.action || "checkin");
    const date = String(body.date || todayJst()).slice(0, 10);
    const email = String(body.email || "")
      .trim()
      .toLowerCase()
      .slice(0, 120);
    const name = String(body.name || "").trim().slice(0, 80);
    const role = String(body.role || "").trim().slice(0, 40);
    const memberId = String(body.memberId || "").trim().slice(0, 80);
    if (action !== "checkin") {
      return res.status(400).json({ error: "unsupported action" });
    }
    if (!email && !name) {
      return res.status(400).json({ error: "name or email required" });
    }
    const token = await getAccessToken();
    const path = ATT_DIR + "/" + date + ".json";
    const existing = (await downloadJson(token, path)) || { date, checkins: [], updatedAt: null };
    if (!Array.isArray(existing.checkins)) existing.checkins = [];
    const key = email || name;
    const idx = existing.checkins.findIndex(
      (c) => String(c.email || c.name || "").toLowerCase() === key
    );
    const row = {
      name,
      email,
      role,
      memberId,
      at: new Date().toISOString(),
    };
    if (idx >= 0) existing.checkins[idx] = { ...existing.checkins[idx], ...row };
    else existing.checkins.push(row);
    existing.date = date;
    existing.updatedAt = new Date().toISOString();
    await uploadJson(token, path, existing);

    // 名簿（督促用）も更新
    const rosterPath = ATT_DIR + "/roster.json";
    const roster = (await downloadJson(token, rosterPath)) || { staff: [] };
    if (!Array.isArray(roster.staff)) roster.staff = [];
    if (email) {
      const ri = roster.staff.findIndex((s) => String(s.email || "").toLowerCase() === email);
      const srow = { name, email, role, memberId, lastSeen: row.at };
      if (ri >= 0) roster.staff[ri] = { ...roster.staff[ri], ...srow };
      else roster.staff.push(srow);
      roster.updatedAt = row.at;
      await uploadJson(token, rosterPath, roster);
    }

    return res.status(200).json({ ok: true, date, count: existing.checkins.length });
  } catch (e) {
    console.error("[attendance]", e);
    return res.status(500).json({
      error: "attendance failed",
      detail: String(e?.message || e).slice(0, 300),
    });
  }
}
