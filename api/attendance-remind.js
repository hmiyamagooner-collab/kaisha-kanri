// /api/attendance-remind — 未ログイン社員へ出勤・ログイン督促メール
// Cron（Vercel）または手動 POST（Authorization: Bearer CRON_SECRET）
// 環境変数:
//   DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN
//   RESEND_API_KEY（任意・未設定なら送信せずリストのみ返す）
//   ATTENDANCE_FROM（任意・既定: Gooner Portal <onboarding@resend.dev>）
//   CRON_SECRET（任意・ある場合は Bearer 必須）
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY（任意・名簿補完）

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

async function loadSupabaseMembers() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  const res = await fetch(url + "/rest/v1/members?select=id,name,email,role&email=neq.", {
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
    },
  });
  if (!res.ok) return [];
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function sendEmail(to, name) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "no_resend_key" };
  const from = process.env.ATTENDANCE_FROM || "Gooner Portal <onboarding@resend.dev>";
  const portalUrl = process.env.PORTAL_URL || "https://kaisha-kanri.vercel.app/gooner-portal.html";
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

function authorize(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  const cron = req.headers["x-vercel-cron"];
  if (cron) return true;
  return auth === "Bearer " + secret;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const date = todayJst();
    let staff = [];
    const sb = await loadSupabaseMembers();
    sb.forEach(function (m) {
      if (m && m.email) staff.push({ name: m.name, email: String(m.email).toLowerCase(), role: m.role });
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
        if (!staff.some((x) => x.email === em)) staff.push({ name: s.name, email: em, role: s.role });
      });
    }

    const checked = new Set(
      checkins.map((c) => String(c.email || "").toLowerCase()).filter(Boolean)
    );
    const missing = staff.filter((s) => s.email && !checked.has(s.email));
    // デモ用は除外
    const targets = missing.filter((s) => !/demo@gooner-portal\.sales/i.test(s.email));

    const results = [];
    for (const t of targets) {
      const r = await sendEmail(t.email, t.name);
      results.push({ email: t.email, name: t.name, ...r });
      console.log("[attendance-remind]", t.email, r.sent ? "sent" : r.reason);
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
  } catch (e) {
    console.error("[attendance-remind]", e);
    return res.status(500).json({
      error: "remind failed",
      detail: String(e?.message || e).slice(0, 300),
    });
  }
}
