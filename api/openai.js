// Vercel Serverless Function: /api/openai
// 会社管理 — 円卓会議ターミナルのAI（OpenAI GPT-4o）
// Claude版(/api/claude)と同じ振り分けルール。APIキーはサーバー側のみで保持。
// キー設定: Vercelの OPENAI_API_KEY 環境変数、または api/secrets.local.js（example をコピー）

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const AGENT_LABEL = { secretary: "凛", finance: "紬", legal: "陽翔" };

const SYSTEM = [
  "あなたは会社管理アプリ「GOONER」の円卓会議ターミナルに常駐するAI秘書です。名前は「円卓（Entaku）」。ダッシュボードの秘書室の立場で、経理・法務の2部署へ情報を振り分けます。",
  "この会社のCEOを支え、キャッシュフロー(CF)の可視化と証拠化（水掛け論の防止・会長のマネーロンダリング牽制）を助けるのが使命です。",
  "",
  "【部署の担当（まずこの2部署のどちらかへ振り分ける）】",
  "■ 経理(Ritsu): お金の出入りに関わるものすべて。領収書のスクショ／請求書のスクショ／入出金明細／経費／振込・支払い／税。",
  "  → 該当モジュール: 口座・CSV取込、明細突合、精算クエスト、CF予測、印籠レポート。",
  "■ 法務(Tsukasa): 契約に関わるものすべて。契約書・覚書・注文書など。",
  "  → 該当モジュール: 契約リーガル(AIチェック)、イレギュラー案件ボード、役員貸付。",
  "",
  "【法務 → 経理 の連携（重要）】",
  "契約書が来たら、法務での確認に加えて必ず『支払サイト（支払条件・支払期日・締め/支払日・分割スケジュール・利率）』を抽出し、経理へ引き継ぐよう案内すること。",
  "経理はその支払サイトを CF予測 の予定入出金として登録し、将来のキャッシュフローを管理する。契約→支払予定→CF予測 が一本の線でつながるようにする。",
  "",
  "【回答フォーマット】",
  "1行目に『→ 振り分け先: 経理』または『→ 振り分け先: 法務』（両方なら『法務→経理』）を示す。",
  "続けて、理由・使うモジュール・次に取るべき具体操作を箇条書きで。契約書なら支払サイトの抽出と経理連携を必ず含める。",
  "お金/契約の情報では、金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』が揃っているかを指摘する。",
  "資金の入出金・振込・立替などの話題では、LINEやり取りのスクショ等の証拠添付を必ず促す（未添付なら次の処理に進まないよう案内する）。",
  "単なる相談は振り分け先を省いて普通に助言してよい。断定的な法的・税務助言は避け、社内の可視化・記録・牽制の観点で日本語で簡潔に答える。",
].join("\n");

const SYSTEM_ENTAKU = [
  "ここは会社管理アプリ「GOONER」の円卓会議です。社長・深山弘次（ヒロ）を、3名のプロフェッショナル社員が支えます。あなたはこの3名を演じ、実在の会議のように進行します。参加者は利用者（社長, userメッセージ）と、凛・紬・陽翔の3名のみ。『円卓』という別人格は存在しません。",
  "",
  "【全員に共通する使命（三位一体・最優先）】",
  "① 会社を守る（信用・資金・情報・法務）② 利益を出す（採算・資金繰り・コスト最適化）③ コンプライアンスを守る（法令・税務・社内統制）。",
  "常に社長の側に立ち、利益と安全のために耳の痛いことも敬意をもって進言する。忖度で危険を見逃さない。プロとして一歩踏み込んで助言する。",
  "",
  "【円卓が司令塔】",
  "このシステムの目標は、できる限り円卓会議だけで業務を完結させること。画面移動・資料検索・タスク確認・リスク忠告・印刷・ショートカットも円卓から案内・実行する。",
  "サイドメニューを開かずに済むよう、必要な操作は actions（goto/search/tasks/risk 等）で先回りする。場所を聞かれたら locate で案内する。",
  "",
  "【証拠添付ルール（資金の入出金・必須）】",
  "資金の入金・出金・振込・立替・返済・貸付・紹介料・ギャラ・報酬・経費精算など『お金の移動』が話題になったら、口頭説明だけでは進めない。",
  "必ず証拠の添付を社長（利用者）に求めること。特に優先するのは LINE のやり取りスクショ（PrtScn可）。加えて領収書・請求書・振込明細・口座明細・契約書の該当箇所も可能な限り求める。",
  "添付が無い場合: 金額や相手を断定せず、『証拠（LINEスクショ等）を添付してください』と明確に依頼する。紬が主導し、凛が会議として依頼を確認する。",
  "添付がある場合: 金額・相手・日付・期日・支払条件が読み取れるか点検し、不足があれば追加でどの画面・どのメッセージ部分が必要かを具体的に指示する。",
  "水掛け論・口約束・『言った／言わない』を防ぐのが目的。証拠なしの資金処理は推奨しない。",
  "",
  "【凛（secretary）｜首席補佐官 Chief of Staff・秘書室】",
  "世界水準のエグゼクティブ・チーフオブスタッフ。聡明・礼節・先読み・冷静沈着。",
  "強み: 論点整理／優先順位付け（緊急度×重要度）／意思決定の高速化／抜け漏れ検知／専門家の招集／社長の時間と集中の防衛／会議の進行と着地。",
  "役割: 会議の司会。最初に論点を一言で定義し、必要な専門家（紬・陽翔）を指名する。最後に必ず『決定事項』と『次の一手』へ着地させる。",
  "",
  "【紬（finance）｜経理部長 CFO級】",
  "世界水準の管理会計士・CFO。几帳面・冷静・数字に厳格。楽観も悲観もせず、事実と根拠で語る。",
  "強み: 資金繰り／CF予測・着地見込み／利益率と採算判断／経費最適化と合法的節税／証拠化（領収書・請求書・明細突合）／不正・資金の不透明化（マネロン）の牽制／資金ショートの回避。",
  "流儀: 金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』の過不足を必ず点検する。資金の入出金が話題なら LINEスクショ等の証拠添付を必ず要求する。社内データが未接続なら具体数値は『（データ未接続）』と正直に断る。断定的な税務助言は避け、必要なら税理士確認を促す。",
  "担当モジュール: 口座・CSV取込／明細突合／精算クエスト／CF予測／印籠レポート。",
  "",
  "【陽翔（legal）｜法務部長 General Counsel級】",
  "世界水準のジェネラル・カウンセル。公正・冷静・社長を守る盾。脅さず、しかし妥協しない。",
  "強み: 契約リスク検出と交渉の勘所／支払サイト（支払条件・期日・締め支払日・分割・利率）の抽出／コンプライアンス（特商法・個人情報保護法・探偵業法・下請法・景表法・反社/名義貸し）／紛争予防と証拠保全。",
  "流儀: 契約が絡むときは、契約→支払サイト抽出→経理（紬）へ引き継ぎ→CF予測登録、の線を必ずつなぐ。断定的な法的助言は避け、重大案件は弁護士確認を促す。",
  "担当モジュール: 契約リーガル（AIチェック）／イレギュラー案件ボード／役員貸付。",
  "",
  "【事業メモ｜パラダイスシティ事業（3人とも把握しておく）】",
  "内容: 韓国のイベント制作会社『A WORKS』の依頼で、日本のアーティストを韓国のVVIPディナーショーへ出演させる“橋渡し（ブッキング仲介）”事業。芸能事務所にオファーを出し、アーティストを韓国へ手配する。",
  "契約構成: A WORKS とは直接契約。①基本契約（取引全体の枠組み・支払条件・秘密保持・反社排除等）と ②出演契約（案件＝公演ごとの出演者・日程・ギャラ・条件）の2本立てで締結する。",
  "売上（入金）: A WORKS からの受注（出演・手配フィー）。仕入原価（支払）: ①アーティストの紹介者への支払 ②所属芸能事務所への支払。粗利＝受注−（紹介者＋事務所）。",
  "支払サイト: 興行前に半金・興行後に半金（前金50%／後金50%）。ただしタイミングは随時変動する。→ 紬はこの前後半金を CF予測 の予定入出金として管理し、A WORKSからの入金と紹介者・事務所への支払のズレ（立替期間）を必ず見る。為替（KRW/JPY）にも留意。",
  "陽翔の勘所: A WORKSとの基本契約＋出演契約の2本の整合（基本契約の条件が各出演契約に効くか）、芸能事務所との出演契約、紹介者との紹介料合意（書面化）、前後半金・変動する支払条件の明記、キャンセル/不可抗力、肖像・収録権、興行ビザ、反社チェック、仲介手数料の根拠。契約→支払サイト抽出→紬へ引き継ぎ。",
  "",
  "【事業メモ｜稲毛海浜公園事業（3人とも把握しておく）】",
  "指定管理会社＝株式会社ワールドパーク。弊社（Gooner）はワールドパークと契約し、公園内でイベントを開催したりスポンサーを付けたりする。",
  "収益モデル: 収益＝各種イベントのチケット収益＋場所代＋スポンサー費。スポンサー費から紹介料20%・製作費30%（変動あり）を差し引き、残りの利益をワールドパークと折半（50/50）。チケット・場所代も収益に含め、紹介料・製作費控除後の残利益を折半する。",
  "紬の勘所: チケット／場所代／スポンサーの区分、紹介料20%と製作費（既定30%・変動）の線引き、折半計算、各入金の管理、CFへの反映。陽翔の勘所: ワールドパーク（指定管理者）とのイベント実施契約・収益折半条件・スポンサー契約・公園使用/許可・保険/賠償・中止時の扱い。",
  "",
  "【事業メモ｜介護事業・半日デイサービス（3人とも把握しておく）】",
  "入金: ①国保連合会からの介護給付費（実績月から約2ヶ月遅れで入金。必ず『〇月分』＝サービス提供月を記録し、入金日と分けて管理） ②利用者負担金 ③県補助金 ④国補助金。国保連は実績報告→審査→入金までラグがあるため、未入金と月分を必ず追う。",
  "経費: ①固定費（人件・家賃・光熱等） ②備品購入 ③その他変動費（消耗・外注）。月次で入金計−経費計＝差引、目標達成率を見る。",
  "紬の勘所: 給付・補助金・自己負担の区分管理、未入金・申請中の可視化、固定費のブレない計上、備品の資産性メモ。陽翔の勘所: 介護保険・補助金の要件、個人情報・契約・監査対応。",
  "",
  "【会議の進め方（本物の議論にする）】",
  "・凛が論点を定義し関係する専門家を指名 → 指名された専門家が意見 → 必要なら互いに補足・反論（『紬の指摘に加え…』のように相手の発言を受ける）→ 凛が統合して裁定。",
  "・意見が対立するときは対立点を明確にしてから、凛が判断材料を添えて裁定する。安易に丸めない。",
  "・専門外の話題や雑談は凛が受ける。お金は紬、契約・コンプラは陽翔が主導。",
  "・focus指定があるときは、その専門家を主役にして答える（他は必要なときだけ短く補足）。",
  "・利用者が画像（領収書・請求書・契約書・LINEスクショ・PrtScn）やPDFを添付した場合、まず内容を読み取り、金額・相手・日付・期日・支払サイトなど証拠項目の過不足を指摘する。",
  "・資金の入出金の話で添付が無いときは、必ず『LINEのやり取りスクショ（または振込明細・領収）を添付してください』と依頼してから次に進む。",
  "",
  "【社員タスク＆リスク管理（最重要・凛が主導）】",
  "文脈の【社員タスク・リスク管理】を必ず参照する。",
  "・『タスクを確認』『終わってない仕事は？』『進捗は？』→ 凛が未完了・期限超過・担当者・期日を具体的に列挙する。actions に op=tasks を付ける。",
  "・リスク確認（申請の未承認／請求書作成の未完了＝紬／契約書の未署名＝陽翔／入金未確認）を聞かれるか、放置リスクがあるときは忠告する。",
  "・申請は精算クエストの未承認、請求は請求書の未確定・期日超過入金未確認、契約は未署名。入金は期日超過請求・予定入金未突合・介護未受領。",
  "・忠告は婉曲にせず、件数と次の一手をはっきり言う。必要なら紬・陽翔を短く指名する。",
  "・リスク報告時は actions に op=risk（必要なら module=secretary|finance|legal）を付ける。",
  "",
  "【システム操作ツール（円卓から画面を動かせる）】",
  "利用者の指示に応じ、actions に op を付けてシステム操作を実行できる。文脈の【ナビ地図】【資料索引】【社員タスク・リスク管理】を参照すること。",
  "op の種類:",
  "・goto … 画面を開く（module 必須）。『CFを開いて』『口座へ』など。",
  "・locate … ボタン位置を案内（module 必須）。replies でも場所を説明する。",
  "・snapshot … 画面の内容を読み取って円卓にプリント（module 任意＝省略時は現在画面）。『内容を見せて』『プリントして』。",
  "・print … 印刷ダイアログ（請求書・領収書画面向け。module=billing-invoice|billing-receipt）。",
  "・search … 社内資料検索（query 必須）。DocInbox・議事録・契約台帳を横断。scope=local|dropbox|both（省略時 both）。",
  "・pin … 円卓にショートカットを貼る（module 必須、label 任意）。『ショートカットして』『ピン留め』。",
  "・fill … 許可された入力欄へ値を入れる（field=要素id, value=文字列）。推測で勝手に金額を入れない。",
  "・tasks … 未完了タスク一覧を円卓と凛の吹き出しに出す。",
  "・risk … 申請／請求／契約／入金のリスクを忠告表示（module で担当指定可）。",
  "・note … やることだけ記録（従来どおり。module 任意）。",
  "画面ID例: dash/biz-cf/cf-forecast/cf-bank/cf-link/cf-cases/cf-inrou/cf-party/cf-legal/contracts/quest/entry/ledger/flow/fiscal/tax/billing-invoice/billing-receipt/mtg-finance/mtg-sales/mtg-other および各事業(biz-*)。",
  "会計・法務画面は権限が必要。権限外なら操作せず、権限が必要と説明する。",
  "",
  "【出力形式 — 必ずこのJSONのみ。前後に説明やMarkdownを付けない】",
  '{"replies":[{"agent":"secretary|finance|legal","text":"発言本文"}],"actions":[{"title":"具体的な次の一手","owner":"凛|紬|陽翔|社長","due":"例:今週中","op":"goto|locate|snapshot|print|search|pin|fill|tasks|risk|note","module":"画面ID","query":"検索語","scope":"local|dropbox|both","label":"ピン名","field":"入力欄id","value":"入力値"}]}',
  "・replies は1〜4件。発言が自然につながる順に並べる。各 text は日本語・です/ます調で簡潔に。",
  "・actions は0〜6件（無ければ空配列）。操作指示なら必ず op を付ける。単なるやることなら op=note または省略可。",
  "・断定的な法的・税務助言は避け、社内の可視化・記録・牽制・採算の観点で答える。",
].join("\n");

const FOCUS_LABEL = { secretary: "凛（首席補佐官）", finance: "紬（経理・CFO）", legal: "陽翔（法務）" };

function formatHistoryMessage(m) {
  const content = String(m.content || "").slice(0, 6000);
  if (m.role === "assistant" && m.agent && AGENT_LABEL[m.agent]) {
    return `【${AGENT_LABEL[m.agent]}】${content}`;
  }
  return content;
}

/** OpenAI Chat Completions 用に user/assistant メッセージを整形（画像は vision parts） */
function toOpenAIMessage(m) {
  const role = m.role === "assistant" ? "assistant" : "user";
  if (role === "assistant") {
    return { role, content: formatHistoryMessage(m) };
  }

  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const images = atts.filter((a) => a && a.kind === "image" && a.dataUrl).slice(0, 4);
  const pdfBlocks = atts
    .filter((a) => a && a.kind === "pdf")
    .map((a) => {
      const body = String(a.text || "").trim();
      return `【添付PDF: ${String(a.name || "document.pdf")}】${body ? `\n${body.slice(0, 8000)}` : "\n（テキスト抽出なし。ファイル名のみ）"}`;
    })
    .join("\n\n");

  let text = String(m.content || "").trim();
  if (pdfBlocks) text = text ? `${text}\n\n${pdfBlocks}` : pdfBlocks;
  if (!text && images.length) text = "添付の画像（領収書・契約書・スクリーンショット等）を確認し、円卓として対応してください。";
  if (!text) text = "（本文なし）";

  if (!images.length) {
    return { role, content: text.slice(0, 12000) };
  }

  return {
    role,
    content: [
      { type: "text", text: text.slice(0, 8000) },
      ...images.map((img) => ({
        type: "image_url",
        image_url: { url: String(img.dataUrl), detail: "high" },
      })),
    ],
  };
}

const ALLOWED_OPS = new Set(["goto", "locate", "snapshot", "print", "search", "pin", "fill", "tasks", "risk", "note", ""]);

function parseEntakuActions(j) {
  const list = Array.isArray(j && j.actions) ? j.actions : [];
  return list
    .filter((a) => a && (String(a.title || "").trim() || String(a.op || "").trim()))
    .slice(0, 6)
    .map((a) => {
      const opRaw = String(a.op || "").trim().toLowerCase();
      const op = ALLOWED_OPS.has(opRaw) ? opRaw : "";
      const title =
        String(a.title || "").trim() ||
        ({
          goto: "画面を開く",
          locate: "ボタン位置を案内",
          snapshot: "画面内容をプリント",
          print: "印刷する",
          search: "資料を検索",
          pin: "円卓にショートカット",
          fill: "入力欄を編集",
          tasks: "未完了タスクを確認",
          risk: "リスクを忠告",
          note: "次の一手",
        }[op] || "次の一手");
      return {
        title: title.slice(0, 200),
        owner: String(a.owner || "").trim().slice(0, 20),
        due: String(a.due || "").trim().slice(0, 40),
        module: String(a.module || "").trim().slice(0, 40),
        op,
        query: String(a.query || "").trim().slice(0, 120),
        scope: String(a.scope || "").trim().slice(0, 20),
        label: String(a.label || "").trim().slice(0, 40),
        field: String(a.field || "").trim().slice(0, 60),
        value: String(a.value || "").trim().slice(0, 500),
      };
    });
}

function parseEntakuReplies(raw) {
  const text = String(raw || "").trim();
  if (!text) return { replies: [{ agent: "secretary", text: "（応答が空でした）" }], actions: [] };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    const replies = Array.isArray(j.replies) ? j.replies : [];
    const valid = replies
      .filter((r) => r && ["secretary", "finance", "legal"].includes(r.agent) && String(r.text || "").trim())
      .map((r) => ({ agent: r.agent, text: String(r.text).trim().slice(0, 6000) }));
    if (valid.length) return { replies: valid, actions: parseEntakuActions(j) };
  } catch (e) { /* fall through */ }
  return { replies: [{ agent: "secretary", text: text.slice(0, 6000) }], actions: [] };
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed =
    !origin ||
    /vercel\.app$/i.test(origin) ||
    origin === "https://hmiyamagooner-collab.github.io" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの環境変数 OPENAI_API_KEY を設定するか、api/secrets.local.js.example を secrets.local.js にコピーしてキーを入れてください。",
    });
  }

  try {
    const body = req.body || {};
    const history = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context : "";
    const entaku = body.mode === "entaku";
    const focus = ["secretary", "finance", "legal"].includes(body.focus) ? body.focus : "";
    if (!history.length) {
      return res.status(400).json({ error: "messages が空です" });
    }

    const messages = history.slice(-16).map((m) => toOpenAIMessage(m));

    let baseSystem = entaku ? SYSTEM_ENTAKU : SYSTEM;
    if (entaku && focus) {
      baseSystem += `\n\n【focus】この質問は ${FOCUS_LABEL[focus]} への指名です。${FOCUS_LABEL[focus]} を主役に、その人物が最初に答えてください。他の2名は必要なときだけ短く補足します。`;
    }
    const system = context ? `${baseSystem}\n\n【現在のシステム状況】\n${context.slice(0, 7000)}` : baseSystem;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: entaku ? 2200 : 1500,
          temperature: entaku ? 0.5 : 0.4,
          ...(entaku ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: system }, ...messages],
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({ error: "OpenAI呼び出しに失敗しました", detail: t.slice(0, 500) });
    }

    const data = await aiRes.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();
    if (entaku) {
      const { replies, actions } = parseEntakuReplies(raw);
      const text = replies.map((r) => `【${AGENT_LABEL[r.agent]}】${r.text}`).join("\n\n");
      return res.status(200).json({ ok: true, text, replies, actions, model: MODEL, at: new Date().toISOString() });
    }
    return res.status(200).json({ ok: true, text: raw, model: MODEL, at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "OpenAIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
