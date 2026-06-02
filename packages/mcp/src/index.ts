/**
 * stable-mcp — remote MCP server (MVP)
 *
 * Exposes 7 tools (transfer, quote-bridge, bridge, list-chains, balance, search-docs, read-doc) over stateful Streamable HTTP,
 * testnet-only, bearer-token auth, single-instance in-memory session store.
 * Conforms to MCP spec 2025-11-25 (lifecycle + Streamable HTTP transport).
 *
 * CUSTODY: HTTP + a signing key means anyone with the URL + token can move that
 * key's funds. This deployment is TESTNET-ONLY (enforced at boot) and must be
 * funded with throwaway testnet funds only. Mainnet waits for the full plan.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { createPublicClient, http, erc20Abi, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createStable,
  Network,
  Chain,
  CHAIN_CONFIGS,
  type ChainConfig,
  StableValidationError,
  StableQuoteError,
  StableTransactionError,
  StableNetworkError,
} from "@stablechain/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

// Custody rule (non-negotiable): refuse to boot off testnet. Blast radius = test USDT.
if (process.env.STABLE_NETWORK !== "testnet") throw new Error("MVP is testnet-only");

const PRIVATE_KEY = process.env.STABLE_PRIVATE_KEY;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!PRIVATE_KEY) throw new Error("STABLE_PRIVATE_KEY is required");
if (!AUTH_TOKEN) throw new Error("MCP_AUTH_TOKEN is required");

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const stable = createStable({ network: Network.Testnet, account });

// Read-only client for the stable chain. Testnet-only deployment → stable-testnet config.
// The SDK has no balance method, so we read ERC20 balanceOf directly via viem.
const STABLE_CHAIN_CONFIG: ChainConfig | undefined = CHAIN_CONFIGS[Chain.StableTestnet];
if (!STABLE_CHAIN_CONFIG) throw new Error("missing stable-testnet chain config");
const stableChainConfig: ChainConfig = STABLE_CHAIN_CONFIG;
const stablePublicClient = createPublicClient({ transport: http(stableChainConfig.rpc) });

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? "").split(",").filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
const PORT = Number(process.env.PORT ?? 3000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 1_800_000); // 30 min idle eviction
// Bind 127.0.0.1 for local dev; deploy sets HOST=0.0.0.0 behind the platform's HTTPS proxy.
const BIND_HOST = process.env.HOST ?? "127.0.0.1";

// ─────────────────────────────────────────────────────────────────────────────
// Tool result helpers + SDK error mapping
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex address")
  .describe("A 0x-prefixed, 40-hex-character EVM address (e.g. 0xabc...123).");
const AMOUNT = z
  .number()
  .positive()
  .describe(
    "Token amount in human-readable units, NOT base units/wei (e.g. 1.5 means 1.5 USDT). The SDK scales by the token's decimals.",
  );
const DECIMALS = z
  .number()
  .int()
  .nonnegative()
  .describe("Token decimals. Omit to let the SDK read it on-chain (USDT0 is 6).");

type ToolOk = Record<string, unknown>;

function ok(structuredContent: ToolOk, text: string) {
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

/**
 * Map SDK errors to the 5 stable codes and an ACTIONABLE message. No retry logic.
 * The recovery hint goes in the `message` string (structuredContent stays {code, message}
 * so it keeps validating against each tool's outputSchema).
 */
function fail(e: unknown) {
  // viem BaseError (which StableError extends) exposes a concise `shortMessage`.
  const base =
    (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);

  let code = "STABLE_ERROR";
  let detail = "";
  let hint = "Inspect the message; the inputs or network may be at fault.";

  if (e instanceof StableValidationError) {
    code = "INVALID_INPUT";
    detail = ` (field: ${e.field}, value: ${JSON.stringify(e.value)})`;
    hint =
      "Fix that parameter. For chain values, fromToken/toToken addresses and decimals, call stable_list_chains.";
  } else if (e instanceof StableQuoteError) {
    code = "QUOTE_FAILED";
    if (e.httpStatus) detail = ` (provider: ${e.provider}, status: ${e.httpStatus})`;
    hint =
      "The bridge provider could not quote. Verify fromChain/toChain, token addresses and amount, then retry stable_quote_bridge.";
  } else if (e instanceof StableTransactionError) {
    code = "TX_REVERTED";
    detail = ` (phase: ${e.phase}${e.revertReason ? `, revert: ${e.revertReason}` : ""})`;
    hint =
      "The transaction did not settle. Check the wallet's funds with stable_balance and confirm the inputs before retrying.";
  } else if (e instanceof StableNetworkError) {
    code = "RPC_UNAVAILABLE";
    hint = "The RPC/network is temporarily unreachable. Wait briefly and retry the same call.";
  }

  const message = `${base}${detail} — ${hint}`;
  return ok({ code, message }, `${code}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Docs lookup — rides the published docs (llms.txt index + .md pages). No extra infra.
// Covers conceptual nuance the action tools can't express (e.g. balance reconciliation).
// ─────────────────────────────────────────────────────────────────────────────

const DOCS_BASE_URL = (process.env.DOCS_BASE_URL ?? "https://docs.stable.xyz").replace(/\/+$/, "");
const DOCS_HOST = new URL(DOCS_BASE_URL).host;
const LLMS_TXT_URL = `${DOCS_BASE_URL}/llms.txt`;
const DOCS_INDEX_TTL_MS = Number(process.env.DOCS_INDEX_TTL_MS ?? 3_600_000); // 1h
const DOC_MAX_CHARS = Number(process.env.DOC_MAX_CHARS ?? 50_000);

interface DocEntry {
  title: string;
  url: string;
  description: string;
}
let docIndexCache: { entries: DocEntry[]; fetchedAt: number } | undefined;

// Parse llms.txt list lines: "- [Title](url): description".
const LLMS_LINE = /^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/;

async function loadDocIndex(): Promise<DocEntry[]> {
  const now = Date.now();
  if (docIndexCache && now - docIndexCache.fetchedAt < DOCS_INDEX_TTL_MS) return docIndexCache.entries;
  const res = await fetch(LLMS_TXT_URL);
  if (!res.ok) throw new Error(`llms.txt fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const entries: DocEntry[] = [];
  for (const raw of text.split("\n")) {
    const m = LLMS_LINE.exec(raw.trim());
    if (m) entries.push({ title: m[1], url: m[2], description: (m[3] ?? "").trim() });
  }
  docIndexCache = { entries, fetchedAt: now };
  return entries;
}

// Keyword scoring. A page that matches MORE of the distinct query terms should win,
// even over a page with a single strong (title) hit — so coverage dominates, with
// title/description weight as the tiebreaker.
function scoreDoc(entry: DocEntry, terms: string[]): number {
  const title = entry.title.toLowerCase();
  const desc = entry.description.toLowerCase();
  let coverage = 0;
  let weight = 0;
  for (const t of terms) {
    const inTitle = title.includes(t);
    const inDesc = desc.includes(t);
    if (inTitle || inDesc) coverage += 1;
    if (inTitle) weight += 3;
    else if (inDesc) weight += 1;
  }
  return coverage * 10 + weight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools — registered fresh on each per-session McpServer
// ─────────────────────────────────────────────────────────────────────────────

function registerTools(server: McpServer): void {
  // stable_transfer — write
  server.registerTool(
    "stable_transfer",
    {
      title: "Transfer USDT",
      description:
        "Send USDT from THIS server's own wallet to another address on the Stable testnet. " +
        "The sender is always this server's wallet (custodial) — you cannot choose the sender. " +
        "This moves real testnet funds and is irreversible; there is no confirmation step. " +
        "By default it sends native USDT0; pass `token` to send a specific ERC-20 instead. " +
        "Returns `txHash` (submitted, not necessarily finalized) — verify with stable_balance if needed. " +
        "On failure, returns a `code` + `message` instead of a hash.",
      inputSchema: {
        to: ADDRESS.describe("Recipient address that will receive the funds."),
        amount: AMOUNT,
        token: ADDRESS.optional().describe(
          "ERC-20 token contract address to send. Omit to send native USDT0 (the usual case).",
        ),
        tokenDecimals: DECIMALS.optional(),
      },
      outputSchema: {
        txHash: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ to, amount, token, tokenDecimals }) => {
      try {
        // TransferParams.from is required; the shared server signer is always the sender (custodial).
        const res = await stable.transfer({ from: account.address, to, amount, token, tokenDecimals });
        return ok({ txHash: res.txHash }, `transfer submitted: ${res.txHash}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // stable_quote_bridge — read-only
  server.registerTool(
    "stable_quote_bridge",
    {
      title: "Quote a bridge",
      description:
        "Estimate how much USDT arrives on the destination chain for a cross-chain bridge, before committing. " +
        "Read-only: sends no transaction and moves no funds. " +
        "Call stable_list_chains first to get valid chain values plus each chain's USDT token address and decimals to pass here. " +
        "Returns the estimated `toAmount` (human-readable, destination side); it may be omitted if the provider can't price it, and it can change, so quote again right before stable_bridge.",
      inputSchema: {
        fromChain: z
          .nativeEnum(Chain)
          .describe("Source chain. Must be one of the `name` values from stable_list_chains."),
        toChain: z
          .nativeEnum(Chain)
          .describe("Destination chain. Must be one of the `name` values from stable_list_chains."),
        fromToken: ADDRESS.describe(
          "USDT token contract address on the source chain (the `usdt` field from stable_list_chains).",
        ),
        toToken: ADDRESS.describe(
          "USDT token contract address on the destination chain (the `usdt` field from stable_list_chains).",
        ),
        amount: AMOUNT,
        fromDecimals: DECIMALS.optional().describe(
          "Decimals of the source token. Omit to use the SDK default of 6 (USDT0).",
        ),
      },
      outputSchema: {
        toAmount: z.number().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fromChain, toChain, fromToken, toToken, amount, fromDecimals }) => {
      try {
        const q = await stable.quoteBridge({ fromChain, toChain, fromToken, toToken, amount, fromDecimals });
        return ok({ toAmount: q.toAmount }, `quote: ${q.toAmount ?? "unknown"} on ${toChain}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // stable_bridge — write; call quote first
  server.registerTool(
    "stable_bridge",
    {
      title: "Bridge USDT",
      description:
        "Move USDT from one chain to another, spending from THIS server's own wallet (custodial — you cannot choose the sender). " +
        "Moves real testnet funds and is irreversible; call stable_quote_bridge first to confirm the expected output. " +
        "IMPORTANT: if `recipient` is omitted, the funds arrive at THIS server's own wallet on the destination chain — set `recipient` to send them elsewhere. " +
        "Returns `txHash` for the SOURCE chain only; destination settlement is asynchronous, so the funds will not appear on the destination immediately. " +
        "On failure, returns a `code` + `message` instead.",
      inputSchema: {
        fromChain: z
          .nativeEnum(Chain)
          .describe("Source chain. Must be one of the `name` values from stable_list_chains."),
        toChain: z
          .nativeEnum(Chain)
          .describe("Destination chain. Must be one of the `name` values from stable_list_chains."),
        fromToken: ADDRESS.describe(
          "USDT token contract address on the source chain (the `usdt` field from stable_list_chains).",
        ),
        toToken: ADDRESS.describe(
          "USDT token contract address on the destination chain (the `usdt` field from stable_list_chains).",
        ),
        amount: AMOUNT,
        fromDecimals: DECIMALS.optional().describe(
          "Decimals of the source token. Omit to use the SDK default of 6 (USDT0).",
        ),
        recipient: ADDRESS.optional().describe(
          "Destination-chain address to receive the funds. Omit ONLY if you intend the funds to land in this server's own wallet.",
        ),
      },
      outputSchema: {
        txHash: z.string().optional(),
        toAmount: z.number().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ fromChain, toChain, fromToken, toToken, amount, fromDecimals, recipient }) => {
      try {
        const res = await stable.bridge({ fromChain, toChain, fromToken, toToken, amount, fromDecimals, recipient });
        return ok({ txHash: res.txHash, toAmount: res.toAmount }, `bridge submitted: ${res.txHash}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // stable_list_chains — helper for valid Chain values
  server.registerTool(
    "stable_list_chains",
    {
      title: "List supported chains",
      description:
        "List every supported chain with the exact values needed to build a bridge or quote. " +
        "Read-only. Call this FIRST when bridging: each entry gives the `name` to pass as fromChain/toChain, " +
        "the `usdt` token contract address to pass as fromToken/toToken, the `chainId`, and the token `decimals` (for fromDecimals). " +
        "These are the only valid chain values.",
      outputSchema: {
        chains: z
          .array(
            z.object({
              name: z.string(),
              chainId: z.number(),
              usdt: z.string(),
              decimals: z.number(),
            }),
          )
          .optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () => {
      // CHAIN_CONFIGS keys are Chain enum values; ChainConfig carries id, usdt address, and decimals.
      const chains = Object.entries(CHAIN_CONFIGS)
        .filter((entry): entry is [string, ChainConfig] => !!entry[1])
        .map(([name, cfg]) => ({
          name,
          chainId: cfg.id,
          usdt: cfg.usdt,
          decimals: cfg.decimals,
        }));
      return ok({ chains }, `${chains.length} chains: ${chains.map((c) => c.name).join(", ")}`);
    },
  );

  // stable_balance — read-only USDT balance on the stable chain
  server.registerTool(
    "stable_balance",
    {
      title: "Read USDT balance",
      description:
        "Read a wallet's USDT balance on the Stable chain (testnet). Read-only. " +
        "With no arguments, returns THIS server's own wallet balance for the chain's USDT0 token — " +
        "use it to check funds before stable_transfer/stable_bridge or to confirm a transfer landed. " +
        "Returns `balance` (human-readable string) and `raw` (base units string).\n" +
        "CAVEAT: USDT0 is dual-role — the native gas asset (18 decimals) and an ERC-20 (6 decimals) over the SAME balance. " +
        "This reports the ERC-20 view via balanceOf (6 decimals), which can differ from the native balance by up to 0.000001 USDT0 " +
        "due to fractional reconciliation, so a wallet holding a tiny amount can read as exactly 0 here. " +
        "Treat this as the ERC-20 balance, not an exact native spendable amount. " +
        "See docs: https://docs.stable.xyz/en/explanation/usdt0-behavior#balance-reconciliation",
      inputSchema: {
        address: ADDRESS.optional().describe(
          "Wallet to read. Omit to read this server's own wallet.",
        ),
        token: ADDRESS.optional().describe(
          "ERC-20 token to read. Omit to read the Stable chain's USDT0 token.",
        ),
        tokenDecimals: DECIMALS.optional(),
      },
      outputSchema: {
        address: z.string().optional(),
        token: z.string().optional(),
        raw: z.string().optional(),
        balance: z.string().optional(),
        decimals: z.number().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ address, token, tokenDecimals }) => {
      try {
        const owner = getAddress(address ?? account.address);
        const tokenAddress = getAddress(token ?? stableChainConfig.usdt);
        const decimals = tokenDecimals ?? stableChainConfig.decimals;
        const raw = await stablePublicClient.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        });
        const balance = formatUnits(raw, decimals);
        return ok(
          { address: owner, token: tokenAddress, raw: raw.toString(), balance, decimals },
          `${balance} USDT (${owner})`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // stable_search_docs — read-only search over the published docs index (llms.txt)
  server.registerTool(
    "stable_search_docs",
    {
      title: "Search Stable docs",
      description:
        "Search the official Stable documentation for pages relevant to a query. Read-only; no funds move. " +
        "Use this for behavior and concepts the other tools cannot express — e.g. USDT0 balance reconciliation, " +
        "dual-role native/ERC-20 quirks, contract-design rules, gas semantics, or bridging internals. " +
        "Returns ranked results as {title, url, description}; pass a `url` to stable_read_doc to read the full page.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe("Keywords describing what you need, e.g. 'balance reconciliation' or 'zero address transfer'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max results to return (default 5)."),
      },
      outputSchema: {
        results: z
          .array(z.object({ title: z.string(), url: z.string(), description: z.string() }))
          .optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        const entries = await loadDocIndex();
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const results = entries
          .map((e) => ({ e, s: scoreDoc(e, terms) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit ?? 5)
          .map((x) => x.e);
        if (results.length === 0) {
          return ok({ results: [] }, `No docs matched "${query}". Try broader or different keywords.`);
        }
        const text = results
          .map((r) => `- ${r.title} — ${r.url}${r.description ? `: ${r.description}` : ""}`)
          .join("\n");
        return ok({ results }, text);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        return ok(
          { code: "DOCS_UNAVAILABLE", message: `${message} — the docs index could not be loaded; retry shortly.` },
          `DOCS_UNAVAILABLE: ${message}`,
        );
      }
    },
  );

  // stable_read_doc — read-only fetch of a single docs page (markdown), host-restricted
  server.registerTool(
    "stable_read_doc",
    {
      title: "Read a Stable docs page",
      description:
        `Fetch the full markdown of a single Stable documentation page. Read-only. ` +
        `Pass a \`url\` returned by stable_search_docs. Only ${DOCS_HOST} pages over HTTPS are allowed; ` +
        `the .md form is fetched automatically and pages longer than ${DOC_MAX_CHARS} characters are truncated.`,
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(`A docs page URL on https://${DOCS_HOST} (typically from stable_search_docs).`),
      },
      outputSchema: {
        url: z.string().optional(),
        content: z.string().optional(),
        truncated: z.boolean().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return ok({ code: "INVALID_INPUT", message: `not a valid URL: ${url}` }, `INVALID_INPUT: not a valid URL`);
      }
      // Host allowlist: keep this tool a docs reader, not a general fetch primitive.
      if (parsed.protocol !== "https:" || parsed.host !== DOCS_HOST) {
        return ok(
          { code: "INVALID_INPUT", message: `only https://${DOCS_HOST} pages are allowed` },
          `INVALID_INPUT: host not allowed (${parsed.host})`,
        );
      }
      if (!parsed.pathname.endsWith(".md")) parsed.pathname = `${parsed.pathname}.md`;
      const target = parsed.toString();
      try {
        const res = await fetch(target);
        if (!res.ok) {
          return ok(
            { code: "DOCS_UNAVAILABLE", message: `HTTP ${res.status} fetching ${target}` },
            `DOCS_UNAVAILABLE: HTTP ${res.status}`,
          );
        }
        let content = await res.text();
        const truncated = content.length > DOC_MAX_CHARS;
        if (truncated) content = `${content.slice(0, DOC_MAX_CHARS)}\n\n[truncated]`;
        return ok({ url: target, content, truncated }, content);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        return ok(
          { code: "DOCS_UNAVAILABLE", message: `${message} — could not fetch the page; retry shortly.` },
          `DOCS_UNAVAILABLE: ${message}`,
        );
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Session store — in-memory, SINGLE INSTANCE. Do not run replicas in MVP.
// ─────────────────────────────────────────────────────────────────────────────

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}
const sessions = new Map<string, Session>();

// TTL eviction sweep: close + remove any session idle > SESSION_TTL_MS.
const SWEEP_MS = Math.min(SESSION_TTL_MS, 60_000);
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(id);
      void s.transport.close(); // fires onclose (idempotent delete)
    }
  }
}, SWEEP_MS).unref();

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (express) — one /mcp route handling POST, GET, DELETE
// ─────────────────────────────────────────────────────────────────────────────

const rpcErr = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

const app = express();
app.use(express.json());

// Auth: bearer token check before any MCP handling. No/invalid token → 401.
app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json(rpcErr(-32001, "UNAUTHORIZED"));
    return;
  }
  next();
});

// One McpServer + transport PER SESSION (not per request). Created on `initialize`.
async function createSession(): Promise<StreamableHTTPServerTransport> {
  const server = new McpServer(
    { name: "stable-mcp", version: "0.1.0" },
    {
      instructions:
        "Tools for moving USDT on the Stable network. TESTNET ONLY — all funds are throwaway testnet funds.\n\n" +
        "Custody model: this server holds ONE wallet and signs with it. Every write (stable_transfer, stable_bridge) " +
        "spends from that single server-owned wallet; the caller cannot choose the sender. Treat writes as real, " +
        "irreversible fund movements with no confirmation step.\n\n" +
        "Amounts are human-readable (1.5 = 1.5 USDT), never base units. USDT0 has 6 decimals.\n\n" +
        "Recommended flow:\n" +
        "1. stable_list_chains — get valid chain names plus each chain's USDT address and decimals (needed for bridging).\n" +
        "2. stable_balance — confirm the wallet has funds before any write.\n" +
        "3. stable_quote_bridge — preview a cross-chain result; re-quote right before bridging.\n" +
        "4. stable_transfer / stable_bridge — execute. For bridges, set `recipient` or the funds land back in this server's wallet; " +
        "the returned txHash is the source chain only and destination settlement is asynchronous.\n\n" +
        "When you hit Stable-specific behavior the tools don't capture (e.g. USDT0 balance reconciliation, dual-role native/ERC-20 " +
        "quirks, contract-design rules, bridging internals), search the official docs with stable_search_docs and read a page with " +
        "stable_read_doc instead of guessing.",
    },
  );
  registerTools(server);
  // DNS-rebinding protection (spec MUST): invalid Origin/Host → 403, enforced by the transport.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: ALLOWED_HOSTS,
    ...(ALLOWED_ORIGINS.length ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, lastSeen: Date.now() });
    },
  });
  // Clean the map when the transport closes (idle eviction, DELETE, client disconnect).
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return transport;
}

app.post("/mcp", async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const isInit = isInitializeRequest(req.body);

  if (sid) {
    if (isInit) {
      // initialize WITH a session id → 400
      res.status(400).json(rpcErr(-32600, "INVALID_REQUEST: initialize with existing session"));
      return;
    }
    const s = sessions.get(sid);
    if (!s) {
      // missing/terminated session → 404 so the client re-initializes
      res.status(404).json(rpcErr(-32001, "SESSION_NOT_FOUND"));
      return;
    }
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
    return;
  }

  // no session id
  if (!isInit) {
    // non-init request WITHOUT a session id → 400
    res.status(400).json(rpcErr(-32600, "INVALID_REQUEST: missing session"));
    return;
  }

  // initialize, no session id → create a new session, then let the transport
  // set the MCP-Session-Id response header and emit the initialize result.
  const transport = await createSession();
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req: Request, res: Response) => {
  // Existing session only → opens the SSE stream for server→client messages.
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) {
    res.status(400).json(rpcErr(-32600, "INVALID_REQUEST: no session"));
    return;
  }
  s.lastSeen = Date.now();
  await s.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  // Existing session → terminate. We allow termination, so never 405.
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) {
    res.status(404).json(rpcErr(-32001, "SESSION_NOT_FOUND"));
    return;
  }
  s.lastSeen = Date.now();
  // The transport closes the session on DELETE; onclose removes it from the map.
  await s.transport.handleRequest(req, res);
});

app.listen(PORT, BIND_HOST, () => {
  console.error(`stable-mcp (testnet) listening on ${BIND_HOST}:${PORT}/mcp`);
});
