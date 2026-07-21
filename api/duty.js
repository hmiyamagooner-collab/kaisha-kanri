// /api/duty — 出勤チェックイン＋未ログイン督促メール（Resend）
// POST { action:'checkin', name, email, role, date?, memberId? }
// GET/POST action:'remind' または Cron（Vercel）
// 互換: /api/attendance・/api/attendance-remind からも同じ処理へ誘導
// 環境変数:
//   DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN
//   RESEND_API_KEY（任意・未設定なら送信せずリストのみ）
//   ATTENDANCE_FROM（任意）
//   PORTAL_URL（任意）
//   CRON_SECRET（任意）
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY（任意・名簿）

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

async function loadSupabaseMembers() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  // email が空でない行のみ（壊れた neq. フィルタを廃止）
  const res = await fetch(
    url + "/rest/v1/members?select=id,name,email,role&email=not.is.null",
    {
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
      },
    }
  );
  if (!res.ok) {
    console.warn("[duty] supabase members", res.status, await res.text().catch(() => ""));
    return [];
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows.filter((m) => m && String(m.email || "").trim()) : [];
}

async function sendEmail(to, name) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "no_resend_key" };
  const from = process.env.ATTENDANCE_FROM || "Gooner Portal <onboarding@resend.dev>";
  const portalUrl =
    process.env.PORTAL_URL || "https://kaisha-kanri.vercel.app/gooner-portal.html";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "【出勤確認】ポータルへログインしてください（Gooner）",
      text:
        (name || "社員") +
        " さん\n\n" +
        "本日の出勤・タスク確認がポータル上で未記録です。\n" +
        "ログインのうえ「業務開始」と「タスク確認」を行ってください。\n\n" +
        portalUrl +
        "\n\n— GOONER PORTAL",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { sent: false, reason: data.message || "resend_error", detail: data };
  return { sent: true, id: data.id };
}

function authorizeRemind(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  const cron = req.headers["x-vercel-cron"];
  if (cron) return true;
  return auth === "Bearer " + secret;
}

async function handleCheckin(req, res) {
  const body = req.body || {};
  const date = String(body.date || todayJst()).slice(0, 10);
  const email = String(body.email || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  const name = String(body.name || "").trim().slice(0, 80);
  const role = String(body.role || "").trim().slice(0, 40);
  const memberId = String(body.memberId || "").trim().slice(0, 80);
  if (!email && !name) {
    return res.status(400).json({ error: "name or email required" });
  }

  if (!process.env.DROPBOX_REFRESH_TOKEN || !process.env.DROPBOX_APP_KEY) {
    console.log("[duty/checkin]", JSON.stringify(body));
    return res.status(200).json({
      ok: true,
      stored: "log-only",
      hint: "DROPBOX_* 未設定のためサーバーログのみ記録しました",
    });
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
}

async function handleRemind(req, res) {
  if (!authorizeRemind(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const date = todayJst();
  let staff = [];
  const sb = await loadSupabaseMembers();
  sb.forEach(function (m) {
    if (m && m.email) {
      staff.push({
        name: m.name,
        email: String(m.email).toLowerCase(),
        role: m.role,
      });
    }
  });

  let checkins = [];
  if (process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY) {
    const token = await getAccessToken();
    const day = (await downloadJson(token, ATT_DIR + "/" + date + ".json")) || { checkins: [] };
    checkins = Array.isArray(day.checkins) ? day.checkins : [];
    const roster = (await downloadJson(token, ATT_DIR + "/roster.json")) || { staff: [] };
    (roster.staff || []).forEach(function (s) {
      if (!s || !s.email) return;
      const em = String(s.email).toLowerCase();
      if (!staff.some((x) => x.email === em)) {
        staff.push({ name: s.name, email: em, role: s.role });
      }
    });
  }

  const checked = new Set(
    checkins.map((c) => String(c.email || "").toLowerCase()).filter(Boolean)
  );
  const missing = staff.filter((s) => s.email && !checked.has(s.email));
  const targets = missing.filter((s) => !/demo@gooner-portal\.sales/i.test(s.email));

  const results = [];
  for (const t of targets) {
    const r = await sendEmail(t.email, t.name);
    results.push({ email: t.email, name: t.name, ...r });
    console.log("[duty/remind]", t.email, r.sent ? "sent" : r.reason);
  }

  return res.status(200).json({
    ok: true,
    date,
    staff: staff.length,
    checkedIn: checked.size,
    reminded: results.filter((r) => r.sent).length,
    pending: results.filter((r) => !r.sent),
    results,
  });
}

function wantsRemind(req) {
  const q = req.query || {};
  const body = req.body || {};
  const action = String(body.action || q.action || "").toLowerCase();
  if (action === "remind") return true;
  if (req.headers["x-vercel-cron"]) return true;
  // Cron / 手動確認は GET で督促
  if (req.method === "GET") return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    if (wantsRemind(req)) {
      return await handleRemind(req, res);
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const action = String((req.body && req.body.action) || "checkin").toLowerCase();
    if (action !== "checkin") {
      return res.status(400).json({ error: "unsupported action" });
    }
    return await handleCheckin(req, res);
  } catch (e) {
    console.error("[duty]", e);
    return res.status(500).json({
      error: "duty failed",
      detail: String(e?.message || e).slice(0, 300),
    });
  }
}
