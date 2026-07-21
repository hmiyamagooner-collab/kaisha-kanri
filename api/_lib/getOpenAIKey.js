// OPENAI_API_KEY の取得（Vercel環境変数 → api/secrets.local.js の順）

let cached = null;

export async function getOpenAIKey() {
  if (cached) return cached;
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv) {
    cached = fromEnv;
    return cached;
  }
  try {
    const mod = await import("../secrets.local.js");
    const key = mod.default?.OPENAI_API_KEY || mod.OPENAI_API_KEY || "";
    if (key) cached = key;
    return key;
  } catch {
    return "";
  }
}
