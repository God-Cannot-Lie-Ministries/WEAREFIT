import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SavedBill = {
  id: string;
  name: string;
  category?: string;
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const cleanText = (value: unknown, limit = 160) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

function dateOnly(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currencyString(value: unknown) {
  const amount = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount.toFixed(2) : "";
}

function safeBills(value: unknown): SavedBill[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((bill) => ({
      id: cleanText((bill as Record<string, unknown>)?.id, 80),
      name: cleanText((bill as Record<string, unknown>)?.name, 120),
      category: cleanText((bill as Record<string, unknown>)?.category, 60),
    }))
    .filter((bill) => bill.id && bill.name)
    .slice(0, 80);
}

function wordSet(value: unknown) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}

function bestBillMatch(vendorName: string, accountNumberHint: string, bills: SavedBill[]) {
  const vendorWords = wordSet(`${vendorName} ${accountNumberHint}`);
  if (!vendorWords.size) return { id: "", confidence: 0 };
  let best = { id: "", confidence: 0 };
  for (const bill of bills) {
    const billWords = wordSet(bill.name);
    const overlap = [...billWords].filter((word) => vendorWords.has(word)).length;
    const confidence = billWords.size ? overlap / billWords.size : 0;
    if (confidence > best.confidence) best = { id: bill.id, confidence };
  }
  return best.confidence >= 0.35 ? best : { id: "", confidence: 0 };
}

function parseModelJson(content: unknown) {
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "string" ? part : (part as Record<string, unknown>)?.text || ""))
      .join("");
    return parseModelJson(text);
  }
  const raw = String(content || "").trim();
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  return JSON.parse(jsonText);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) throw new Error("Authentication required.");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiApiKey) throw new Error("Bill screenshot analysis is not configured yet.");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Authentication required.");

    const body = await request.json();
    const imageUrl = cleanText(body.imageUrl, 6000);
    const imageDataUrl = String(body.imageDataUrl || "").trim();
    const imageInput = imageDataUrl.startsWith("data:image/") ? imageDataUrl : imageUrl;
    if (!/^https?:\/\//.test(imageInput) && !imageInput.startsWith("data:image/")) {
      throw new Error("Upload a bill screenshot before scanning.");
    }
    if (imageInput.length > 8_000_000) throw new Error("Bill screenshot is too large to scan.");

    const bills = safeBills(body.bills);
    const billList = bills.length
      ? bills.map((bill) => `- ${bill.id}: ${bill.name}${bill.category ? ` (${bill.category})` : ""}`).join("\n")
      : "No saved bills were provided.";
    const prompt = `You are extracting ONLY the new current bill payment data from a utility or bill screenshot for F.I.T.

Return JSON only. Do not include markdown.

Primary task:
- Find the current/new bill company or payee.
- Find the current/new amount due.
- Find the current/new due date.
- Suggest which saved bill it most likely belongs to.

Rules:
- Do not infer or rewrite previous bill history.
- Do not use previous amount, previous balance, account balance, autopay draft date, or statement date as the due date.
- If several amounts are visible, choose the current amount due or total amount due for the next payment.
- If no reliable amount or due date is visible, return an empty string for that field.
- matchedBillId must be one of the saved bill IDs below or an empty string.

Saved bills:
${billList}

JSON fields:
vendorName, amountDue, dueDate, matchedBillId, accountNumberHint, confidence, notes.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_BILL_SCAN_MODEL") || "gpt-5.6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageInput } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fit_bill_screenshot_scan",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                vendorName: { type: "string" },
                amountDue: { type: "string" },
                dueDate: { type: "string" },
                matchedBillId: { type: "string" },
                accountNumberHint: { type: "string" },
                confidence: { type: "number" },
                notes: { type: "string" },
              },
              required: [
                "vendorName",
                "amountDue",
                "dueDate",
                "matchedBillId",
                "accountNumberHint",
                "confidence",
                "notes",
              ],
            },
          },
        },
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || "Bill screenshot analysis failed.");
    }

    const parsed = parseModelJson(result.choices?.[0]?.message?.content);
    const vendorName = cleanText(parsed.vendorName, 120);
    const amountDue = currencyString(parsed.amountDue);
    const dueDate = dateOnly(parsed.dueDate);
    const modelMatchedBillId = cleanText(parsed.matchedBillId, 100);
    const allowedMatch = bills.some((bill) => bill.id === modelMatchedBillId) ? modelMatchedBillId : "";
    const fallbackMatch = allowedMatch ? { id: allowedMatch, confidence: Number(parsed.confidence) || 0 } : bestBillMatch(vendorName, parsed.accountNumberHint, bills);

    return new Response(
      JSON.stringify({
        ok: true,
        scan: {
          vendorName,
          amountDue,
          dueDate,
          matchedBillId: fallbackMatch.id,
          accountNumberHint: cleanText(parsed.accountNumberHint, 80),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || fallbackMatch.confidence || 0)),
          notes: cleanText(parsed.notes, 220),
          scannedAt: new Date().toISOString(),
          scannedBy: normalizeEmail(authData.user.email),
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "Bill screenshot analysis failed." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
