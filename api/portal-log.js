// Vercel Serverless Function: /api/portal-log
// 利用者ログイン・円卓利用などの記録＋社長によるタスク削除（service role）

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return {};
}

async function supabaseUser(token) {
  const url = process.env.SUPABASE_URL;
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !token) return null;
  const res = await fetch(url + "/auth/v1/user", {
    headers: {
      apikey: anon,
      Authorization: "Bearer " + token,
    },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function memberForUser(user) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !user) return null;
  const headers = {
    apikey: key,
    Authorization: "Bearer " + key,
  };
  if (user.id) {
    const q1 = await fetch(
      url +
        "/rest/v1/members?select=id,name,role,email,auth_user_id&auth_user_id=eq." +
        encodeURIComponent(user.id) +
        "&limit=1",
      { headers }
    );
    if (q1.ok) {
      const rows = await q1.json();
      if (Array.isArray(rows) && rows[0]) return rows[0];
    }
  }
  const email = String(user.email || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  const q2 = await fetch(
    url +
      "/rest/v1/members?select=id,name,role,email,auth_user_id&email=eq." +
      encodeURIComponent(email) +
      "&limit=1",
    { headers }
  );
  if (!q2.ok) return null;
  const rows = await q2.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function deleteTaskServer(taskId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: "service_role_missing" };
  const id = String(taskId || "").trim();
  if (!id) return { ok: false, error: "taskId required" };
  const headers = {
    apikey: key,
    Authorization: "Bearer " + key,
    Prefer: "return=representation",
  };
  // 物理削除
  const del = await fetch(
    url + "/rest/v1/tasks?id=eq." + encodeURIComponent(id),
    { method: "DELETE", headers }
  );
  const delText = await del.text();
  let delRows = [];
  try {
    delRows = delText ? JSON.parse(delText) : [];
  } catch (e) {
    delRows = [];
  }
  if (del.ok && Array.isArray(delRows) && delRows.length) {
    return { ok: true, mode: "hard", id };
  }
  // 取り消し（一覧から除外できるマーカー）
  const patch = {
    status: "done",
    completed_at: new Date().toISOString(),
    title: "（削除）",
    detail: "[DELETED]",
  };
  const upd = await fetch(
    url + "/rest/v1/tasks?id=eq." + encodeURIComponent(id),
    {
      method: "PATCH",
      headers: Object.assign({}, headers, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(patch),
    }
  );
  const updText = await upd.text();
  let updRows = [];
  try {
    updRows = updText ? JSON.parse(updText) : [];
  } catch (e) {
    updRows = [];
  }
  if (upd.ok && Array.isArray(updRows) && updRows.length) {
    return { ok: true, mode: "soft", id };
  }
  return {
    ok: false,
    error: "delete_failed",
    detail: (delText || updText || "").slice(0, 200),
  };
}

async function setDropboxAllowedServer(memberId, allowed) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: "service_role_missing" };
  const id = String(memberId || "").trim();
  if (!id) return { ok: false, error: "memberId required" };
  const res = await fetch(
    url + "/rest/v1/members?id=eq." + encodeURIComponent(id),
    {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ dropbox_allowed: !!allowed }),
    }
  );
  const text = await res.text();
  let rows = [];
  try {
    rows = text ? JSON.parse(text) : [];
  } catch (e) {
    rows = [];
  }
  if (res.ok && Array.isArray(rows) && rows.length) {
    return { ok: true, id, allowed: !!allowed };
  }
  return { ok: false, error: "update_failed", detail: (text || "").slice(0, 200) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = await readJson(req);
    const action = String(body.action || "event").slice(0, 64);

    if (action === "task-delete") {
      const auth = String(req.headers.authorization || "");
      const token = auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : String(body.accessToken || "").trim();
      if (!token) {
        return res.status(401).json({ ok: false, error: "login_required" });
      }
      const user = await supabaseUser(token);
      if (!user) {
        return res.status(401).json({ ok: false, error: "invalid_session" });
      }
      const member = await memberForUser(user);
      if (!member || String(member.role || "") !== "社長") {
        return res.status(403).json({ ok: false, error: "president_only" });
      }
      const result = await deleteTaskServer(body.taskId || body.id);
      if (!result.ok) {
        return res.status(500).json(result);
      }
      console.log(
        "[portal-log]",
        JSON.stringify({
          at: new Date().toISOString(),
          action: "task-delete",
          name: member.name,
          role: member.role,
          detail: String(body.taskId || body.id || "").slice(0, 80),
        })
      );
      return res.status(200).json(result);
    }

    if (action === "dropbox-allow") {
      const auth = String(req.headers.authorization || "");
      const token = auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : String(body.accessToken || "").trim();
      if (!token) {
        return res.status(401).json({ ok: false, error: "login_required" });
      }
      const user = await supabaseUser(token);
      if (!user) {
        return res.status(401).json({ ok: false, error: "invalid_session" });
      }
      const member = await memberForUser(user);
      if (!member || String(member.role || "") !== "社長") {
        return res.status(403).json({ ok: false, error: "president_only" });
      }
      const result = await setDropboxAllowedServer(body.memberId || body.id, body.allowed);
      if (!result.ok) {
        return res.status(500).json(result);
      }
      console.log(
        "[portal-log]",
        JSON.stringify({
          at: new Date().toISOString(),
          action: "dropbox-allow",
          name: member.name,
          target: String(body.memberId || body.id || "").slice(0, 40),
          allowed: !!body.allowed,
        })
      );
      return res.status(200).json(result);
    }

    const entry = {
      at: new Date().toISOString(),
      action,
      name: String(body.name || "").slice(0, 80),
      role: String(body.role || "").slice(0, 40),
      email: String(body.email || "").slice(0, 120),
      detail: String(body.detail || "").slice(0, 500),
      ua: String(req.headers["user-agent"] || "").slice(0, 200),
    };
    console.log("[portal-log]", JSON.stringify(entry));
    return res.status(200).json({ ok: true, at: entry.at });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "log failed", detail: String(e?.message || e).slice(0, 200) });
  }
}
