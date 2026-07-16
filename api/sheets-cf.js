// Vercel Serverless Function: /api/sheets-cf
// Google Sheets API（サービスアカウント）で第３期GoonerCFを取得し、CF予定行へ変換

import crypto from "crypto";
import { getGoogleSheetsConfig } from "./getGoogleSheets.js";

export const config = { maxDuration: 30 };

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const data = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const sig = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const jwt = `${data}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || "Googleトークン取得に失敗");
  }
  return json.access_token;
}

async function sheetsGet(token, path) {
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || `Sheets API error ${res.status}`);
  }
  return json;
}

function parseYen(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Math.round(v);
  const n = Number(String(v).replace(/[¥￥,\s]/g, "").replace(/[−–—]/g, "-"));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseDayToken(v, lastDay) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (/月末|末日/.test(s)) return lastDay;
  const m = s.match(/(\d{1,2})\s*日/);
  if (m) {
    const d = +m[1];
    return d >= 1 && d <= lastDay ? d : null;
  }
  if (/^\d{1,2}$/.test(s)) {
    const d = +s;
    return d >= 1 && d <= lastDay ? d : null;
  }
  return null;
}

function isIncomeMethod(method) {
  return /入金/.test(String(method || ""));
}

function isSectionLabel(a) {
  const s = String(a || "").trim();
  return /^(収入|固定費|変動費|税金|保留|初期費用|車両費|人件費|通信費|カード|リース|地代家賃|経費)$/.test(s);
}

function detectMonthYear(rows, fallbackYear, fallbackMonth) {
  let year = fallbackYear;
  let month = fallbackMonth;
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const line = (rows[i] || []).map(String).join(" ");
    const ym = line.match(/(20\d{2})\s*[年\/\-]?\s*(\d{1,2})\s*月/);
    if (ym) {
      year = +ym[1];
      month = +ym[2];
      break;
    }
    const mOnly = line.match(/(\d{1,2})\s*月\s*CF|(\d{1,2})\s*月分/);
    if (mOnly) {
      month = +(mOnly[1] || mOnly[2]);
      break;
    }
  }
  return { year, month };
}

function findHeader(rows) {
  for (let r = 0; r < Math.min(30, rows.length); r++) {
    const row = rows[r] || [];
    const a = String(row[0] || "").trim();
    const b = String(row[1] || "").trim();
    if (a === "項目" && (b === "内容" || b.includes("内容"))) {
      const dayCols = {};
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] || "").trim();
        if (/^\d{1,2}$/.test(cell)) dayCols[+cell] = c;
        if (cell === "その他") dayCols.other = c;
        if (cell === "合計") dayCols.total = c;
      }
      return {
        headerRow: r,
        col: {
          item: 0,
          content: 1,
          due: 2,
          method: 3,
          dept: 4,
          dayCols,
        },
      };
    }
  }
  return null;
}

function parseSheet(rows, year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const header = findHeader(rows);
  if (!header) {
    return { ym, entries: [], error: "ヘッダー行（項目/内容/日付列）が見つかりません" };
  }

  let section = "その他";
  let incomeSection = false;
  const entries = [];

  for (let r = header.headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const item = String(row[header.col.item] || "").trim();
    const content = String(row[header.col.content] || "").trim();
    const due = String(row[header.col.due] || "").trim();
    const method = String(row[header.col.method] || "").trim();
    const dept = String(row[header.col.dept] || "").trim();

    if (!item && !content) continue;
    if (/合計|差引/.test(item) || /合計|差引/.test(content)) continue;

    if (isSectionLabel(item) && !content && !due && !method) {
      section = item;
      incomeSection = item === "収入";
      continue;
    }
    if (item === "収入") {
      section = "収入";
      incomeSection = true;
      if (!content) continue;
    }

    const kind = incomeSection || isIncomeMethod(method) || isIncomeMethod(due) ? "in" : "out";
    const label = [item, content].filter(Boolean).join(" / ");
    const dueDay = parseDayToken(due, lastDay);

    const dayAmounts = [];
    Object.keys(header.col.dayCols).forEach((k) => {
      if (k === "other" || k === "total") return;
      const day = +k;
      const col = header.col.dayCols[day];
      const amt = Math.abs(parseYen(row[col]));
      if (amt > 0) dayAmounts.push({ day, amount: amt });
    });

    // 日別列が空で、部署列以降に金額が1つだけあるケース（列ずれ）にも対応
    if (!dayAmounts.length) {
      let lone = 0;
      for (let c = 4; c < Math.min(row.length, 12); c++) {
        const amt = Math.abs(parseYen(row[c]));
        if (amt > 0) {
          if (lone) {
            lone = 0;
            break;
          }
          lone = amt;
        }
      }
      if (lone > 0) {
        const d = dueDay || lastDay;
        dayAmounts.push({ day: d, amount: lone });
      }
    }

    // 引落日だけあり金額が「その他」や合計付近にある場合
    if (!dayAmounts.length && header.col.dayCols.other != null) {
      const amt = Math.abs(parseYen(row[header.col.dayCols.other]));
      if (amt > 0) dayAmounts.push({ day: dueDay || lastDay, amount: amt });
    }

    dayAmounts.forEach(({ day, amount }) => {
      const date = `${ym}-${String(day).padStart(2, "0")}`;
      entries.push({
        date,
        kind,
        amount,
        category: section || item || "その他",
        item,
        content,
        dept,
        method: method || due,
        memo: label,
        source: "gsheet",
        sourceRow: r + 1,
      });
    });
  }

  const sumIn = entries.filter((e) => e.kind === "in").reduce((a, e) => a + e.amount, 0);
  const sumOut = entries.filter((e) => e.kind === "out").reduce((a, e) => a + e.amount, 0);
  return { ym, entries, totals: { in: sumIn, out: sumOut, count: entries.length } };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const cfg = await getGoogleSheetsConfig();
    if (!cfg.clientEmail || !cfg.privateKey) {
      return res.status(500).json({
        error: "Googleサービスアカウントが未設定です",
        hint: "Vercelに GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY を設定し、スプシをそのメールに共有（閲覧者）してください。",
      });
    }

    const q = req.method === "GET" ? req.query || {} : req.body || {};
    const now = new Date();
    const year = Number(q.year) || now.getFullYear();
    const month = Number(q.month) || now.getMonth() + 1;

    const token = await getAccessToken(cfg.clientEmail, cfg.privateKey);
    const meta = await sheetsGet(token, `spreadsheets/${cfg.spreadsheetId}?fields=sheets.properties`);
    const sheet = (meta.sheets || []).map((s) => s.properties).find((p) => p.sheetId === cfg.sheetGid);
    if (!sheet) {
      return res.status(404).json({
        error: `gid=${cfg.sheetGid} のシートが見つかりません`,
        sheets: (meta.sheets || []).map((s) => ({
          title: s.properties?.title,
          sheetId: s.properties?.sheetId,
        })),
      });
    }

    const title = sheet.title;
    const valuesRes = await sheetsGet(
      token,
      `spreadsheets/${cfg.spreadsheetId}/values/${encodeURIComponent(`'${title.replace(/'/g, "''")}'!A1:AL200`)}?majorDimension=ROWS`
    );
    const rows = valuesRes.values || [];
    const detected = detectMonthYear(rows, year, month);
    const parsed = parseSheet(rows, detected.year, detected.month);

    if (parsed.error) {
      return res.status(422).json({ error: parsed.error, sheetTitle: title });
    }

    return res.status(200).json({
      ok: true,
      spreadsheetId: cfg.spreadsheetId,
      sheetTitle: title,
      sheetGid: cfg.sheetGid,
      ym: parsed.ym,
      year: detected.year,
      month: detected.month,
      totals: parsed.totals,
      entries: parsed.entries,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      error: "スプレッドシート取得に失敗しました",
      detail: String((e && e.message) || e).slice(0, 400),
    });
  }
}
