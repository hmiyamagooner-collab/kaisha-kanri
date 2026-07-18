// GET /api/dropbox-auth — Dropbox OAuth 開始
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const key = process.env.DROPBOX_APP_KEY;
  if (!key) {
    return res.status(500).send(
      "DROPBOX_APP_KEY が未設定です。Vercel の Environment Variables に設定してください。"
    );
  }
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const redirect =
    process.env.DROPBOX_REDIRECT_URI ||
    `${proto}://${host}/api/dropbox-callback`;
  const url =
    "https://www.dropbox.com/oauth2/authorize" +
    `?client_id=${encodeURIComponent(key)}` +
    "&response_type=code" +
    "&token_access_type=offline" +
    `&redirect_uri=${encodeURIComponent(redirect)}`;
  res.writeHead(302, { Location: url });
  res.end();
}
