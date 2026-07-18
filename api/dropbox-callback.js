// GET /api/dropbox-callback — code → token 交換してポータルへ返す
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const code = String(req.query?.code || "");
  if (!code) {
    return res.status(400).send("authorization code がありません");
  }
  const key = process.env.DROPBOX_APP_KEY;
  const secret = process.env.DROPBOX_APP_SECRET;
  if (!key || !secret) {
    return res.status(500).send("DROPBOX_APP_KEY / DROPBOX_APP_SECRET が未設定です");
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const redirect =
    process.env.DROPBOX_REDIRECT_URI ||
    `${proto}://${host}/api/dropbox-callback`;

  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirect,
    client_id: key,
    client_secret: secret,
  });
  const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await readJson(tokenRes);
  if (!tokenRes.ok || !data.access_token) {
    return res
      .status(400)
      .send(
        "Dropbox token 取得に失敗しました: " +
          String(data.error_description || data.error || "")
      );
  }

  const base = process.env.DROPBOX_SUCCESS_URL || `${proto}://${host}/gooner-portal`;
  const hash = new URLSearchParams({
    dbx_access: data.access_token,
    dbx_refresh: data.refresh_token || "",
    dbx_expires: String(data.expires_in || 14400),
  }).toString();
  res.writeHead(302, { Location: `${base}#${hash}` });
  res.end();
}
