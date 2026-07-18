// POST /api/dropbox-sync
// body: { action:'download'|'upload'|'refresh', accessToken?, refreshToken?, content? }
const SHARED_PATH = "/GOONER Portal/shared-v1.json";

async function readJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text), raw: text };
  } catch {
    return { ok: res.ok, status: res.status, data: null, raw: text };
  }
}

async function refreshAccessToken(refreshToken) {
  const key = process.env.DROPBOX_APP_KEY;
  const secret = process.env.DROPBOX_APP_SECRET;
  if (!key || !secret || !refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: key,
    client_secret: secret,
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = await readJson(res);
  if (!parsed.ok || !parsed.data?.access_token) return null;
  return parsed.data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = req.body || {};
    const action = String(body.action || "");
    let accessToken = String(body.accessToken || "");
    const refreshToken = String(body.refreshToken || "");

    if (action === "refresh" || (!accessToken && refreshToken)) {
      const refreshed = await refreshAccessToken(refreshToken);
      if (!refreshed) {
        return res.status(401).json({ error: "token refresh failed" });
      }
      if (action === "refresh") {
        return res.status(200).json({
          accessToken: refreshed.access_token,
          expiresIn: refreshed.expires_in || 14400,
        });
      }
      accessToken = refreshed.access_token;
    }

    if (!accessToken) {
      return res.status(401).json({ error: "accessToken required" });
    }

    if (action === "download") {
      const dl = await fetch("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Dropbox-API-Arg": JSON.stringify({ path: SHARED_PATH }),
        },
      });
      if (dl.status === 409 || dl.status === 404) {
        return res.status(200).json({ ok: true, missing: true, content: null });
      }
      const text = await dl.text();
      if (!dl.ok) {
        return res.status(dl.status).json({ error: "download failed", detail: text.slice(0, 300) });
      }
      let content = null;
      try {
        content = JSON.parse(text);
      } catch {
        return res.status(500).json({ error: "invalid shared json" });
      }
      return res.status(200).json({ ok: true, missing: false, content });
    }

    if (action === "upload") {
      const content = body.content;
      if (!content || typeof content !== "object") {
        return res.status(400).json({ error: "content object required" });
      }
      const payload = JSON.stringify(content);
      const up = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: SHARED_PATH,
            mode: "overwrite",
            autorename: false,
            mute: true,
          }),
        },
        body: payload,
      });
      const parsed = await readJson(up);
      if (!up.ok) {
        // 親フォルダが無い場合は作成して再試行
        if (String(parsed.raw || "").includes("path/not_found") || up.status === 409) {
          await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: "/GOONER Portal", autorename: false }),
          });
          const up2 = await fetch("https://content.dropboxapi.com/2/files/upload", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/octet-stream",
              "Dropbox-API-Arg": JSON.stringify({
                path: SHARED_PATH,
                mode: "overwrite",
                autorename: false,
                mute: true,
              }),
            },
            body: payload,
          });
          if (!up2.ok) {
            const t = await up2.text();
            return res.status(up2.status).json({ error: "upload failed", detail: t.slice(0, 300) });
          }
          return res.status(200).json({ ok: true });
        }
        return res.status(up.status).json({
          error: "upload failed",
          detail: String(parsed.raw || "").slice(0, 300),
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: "sync failed", detail: String(e?.message || e).slice(0, 200) });
  }
}
