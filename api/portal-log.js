// Vercel Serverless Function: /api/portal-log
// 利用者ログイン・円卓利用などの記録（Vercelログに出力。管理画面は将来拡張）

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = req.body || {};
    const entry = {
      at: new Date().toISOString(),
      action: String(body.action || "event").slice(0, 64),
      name: String(body.name || "").slice(0, 80),
      role: String(body.role || "").slice(0, 40),
      email: String(body.email || "").slice(0, 120),
      detail: String(body.detail || "").slice(0, 500),
      ua: String(req.headers["user-agent"] || "").slice(0, 200),
    };
    console.log("[portal-log]", JSON.stringify(entry));
    return res.status(200).json({ ok: true, at: entry.at });
  } catch (e) {
    return res.status(500).json({ error: "log failed", detail: String(e?.message || e).slice(0, 200) });
  }
}
