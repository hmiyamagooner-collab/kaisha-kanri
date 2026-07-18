// POST /api/dropbox-sync
// body: { action:'list'|'link'|'refresh', accessToken?, refreshToken?, path? }
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

function normalizePath(p) {
  let s = String(p || "").trim();
  if (!s || s === "/") return "";
  if (!s.startsWith("/")) s = "/" + s;
  return s.replace(/\/+$/, "") || "";
}

function rootPath() {
  return normalizePath(process.env.DROPBOX_ROOT_PATH || "");
}

function underRoot(path) {
  const root = rootPath();
  const p = normalizePath(path);
  if (!root) return true;
  return p === root || p.startsWith(root + "/");
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

    if (action === "list") {
      let path = normalizePath(body.path);
      const root = rootPath();
      if (!path) path = root;
      if (!underRoot(path)) {
        return res.status(403).json({ error: "path outside DROPBOX_ROOT_PATH" });
      }
      const listRes = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path,
          recursive: false,
          include_mounted_folders: true,
          include_non_downloadable_files: true,
          limit: 200,
        }),
      });
      const parsed = await readJson(listRes);
      if (!listRes.ok) {
        return res.status(listRes.status).json({
          error: "list failed",
          detail: String(parsed.raw || "").slice(0, 300),
        });
      }
      const entries = (parsed.data?.entries || []).map((e) => ({
        id: e.id,
        name: e.name,
        path: e.path_display || e.path_lower,
        tag: e[".tag"],
        size: e.size || 0,
        clientModified: e.client_modified || "",
        serverModified: e.server_modified || "",
      }));
      entries.sort((a, b) => {
        if (a.tag === b.tag) return String(a.name).localeCompare(String(b.name), "ja");
        return a.tag === "folder" ? -1 : 1;
      });
      const parent =
        path && path !== root
          ? path.replace(/\/[^/]+$/, "") || root || ""
          : null;
      return res.status(200).json({
        ok: true,
        path: path || "/",
        root: root || "/",
        parent,
        entries,
      });
    }

    if (action === "link") {
      const path = normalizePath(body.path);
      if (!path) return res.status(400).json({ error: "path required" });
      if (!underRoot(path)) {
        return res.status(403).json({ error: "path outside DROPBOX_ROOT_PATH" });
      }
      const linkRes = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      const parsed = await readJson(linkRes);
      if (!linkRes.ok || !parsed.data?.link) {
        return res.status(linkRes.status || 500).json({
          error: "link failed",
          detail: String(parsed.raw || "").slice(0, 300),
        });
      }
      return res.status(200).json({
        ok: true,
        link: parsed.data.link,
        name: parsed.data.metadata?.name || "",
      });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({
      error: "dropbox failed",
      detail: String(e?.message || e).slice(0, 200),
    });
  }
}
