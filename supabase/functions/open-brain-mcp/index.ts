// open-brain-mcp — an MCP server for Open Brain, running as a Supabase Edge Function.
//
// An MCP client (Claude Desktop, via mcp-remote) POSTs JSON-RPC 2.0 messages here.
// We check the Authorization header against MCP_ACCESS_KEY, then answer the
// handful of MCP methods we support: initialize, tools/list, tools/call, ping.
// Every database query goes through the service role key, which Supabase hands
// to this function automatically — nothing is exposed to the client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- Environment (provided by Supabase, no setup needed) ----------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ---------- CORS ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// JSON-RPC helpers
const ok = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) =>
  json({ jsonrpc: "2.0", id, error: { code, message } });

// ---------- Tool definitions (what the AI sees) ----------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search Open Brain by keyword. Matches anywhere in the thought text (case-insensitive). Returns up to 10 results, newest first.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Word or phrase to search for" } },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "Return the most recently saved thoughts (default 10, max 50).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many thoughts to return" } },
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought to Open Brain.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string", description: "The text to save" } },
      required: ["content"],
    },
  },
];

// ---------- Tool implementations ----------
async function runTool(name: string, args: Record<string, unknown>) {
  if (name === "search_thoughts") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const { data, error } = await db
      .from("thoughts")
      .select("id, content, created_at, metadata")
      .ilike("content", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    return data;
  }

  if (name === "list_recent") {
    const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
    const { data, error } = await db
      .from("thoughts")
      .select("id, content, created_at, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  }

  if (name === "add_thought") {
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("content is required");
    // Owner: the first (and only) user account in this project.
    const { data: users } = await db.auth.admin.listUsers({ perPage: 1 });
    const userId = users?.users?.[0]?.id ?? null;
    const { data, error } = await db
      .from("thoughts")
      .insert({ content, user_id: userId, metadata: { source: "mcp" } })
      .select("id, content, created_at")
      .single();
    if (error) throw error;
    return data;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---------- Request handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // mcp-remote may probe with GET; we only speak POST.
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Auth: "Authorization: Bearer <MCP_ACCESS_KEY>"
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${MCP_ACCESS_KEY}`) return json({ error: "Unauthorized" }, 401);

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return fail(null, -32700, "Parse error");
  }

  const { id, method, params = {} } = msg;

  // Notifications (no id) get an empty 202 and no body.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: CORS });
  }

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: params.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "open-brain", version: "1.0.0" },
        });

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS });

      case "tools/call": {
        const result = await runTool(params.name, params.arguments ?? {});
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      }

      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // Tool errors go back inside a result so the AI can read them.
    return ok(id, {
      content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
      isError: true,
    });
  }
});