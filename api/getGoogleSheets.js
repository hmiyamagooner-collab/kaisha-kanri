// Google Sheets 認証設定（Vercel環境変数 → secrets.local.js）

let cached = null;

export async function getGoogleSheetsConfig() {
  if (cached) return cached;

  const fromEnv = {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    spreadsheetId:
      process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
      "1d1LEQ_Mfjqm43r9wLkrqtsbdqWLl9Iyd7bgL6PATxUs",
    sheetGid: Number(process.env.GOOGLE_SHEETS_GID || "1995516463"),
  };

  if (fromEnv.clientEmail && fromEnv.privateKey) {
    cached = fromEnv;
    return cached;
  }

  try {
    const mod = await import("./secrets.local.js");
    const s = mod.default || mod;
    const cfg = {
      clientEmail: s.GOOGLE_SERVICE_ACCOUNT_EMAIL || fromEnv.clientEmail,
      privateKey: String(s.GOOGLE_PRIVATE_KEY || fromEnv.privateKey).replace(/\\n/g, "\n"),
      spreadsheetId: s.GOOGLE_SHEETS_SPREADSHEET_ID || fromEnv.spreadsheetId,
      sheetGid: Number(s.GOOGLE_SHEETS_GID || fromEnv.sheetGid),
    };
    if (cfg.clientEmail && cfg.privateKey) {
      cached = cfg;
      return cached;
    }
  } catch {
    /* no local secrets */
  }
  return fromEnv;
}
