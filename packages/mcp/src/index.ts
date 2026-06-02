/**
 * stable-mcp — remote MCP server (MVP)
 *
 * Exposes 5 tools (transfer, bridge, list-chains, balance) over stateful Streamable HTTP,
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
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex address");
const AMOUNT = z.number().positive();
const DECIMALS = z.number().int().nonnegative();

type ToolOk = Record<string, unknown>;

function ok(structuredContent: ToolOk, text: string) {
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

/** Map SDK errors to the 5 stable codes. No retry logic. */
function fail(e: unknown) {
  let code = "STABLE_ERROR";
  if (e instanceof StableValidationError) code = "INVALID_INPUT";
  else if (e instanceof StableQuoteError) code = "QUOTE_FAILED";
  else if (e instanceof StableTransactionError) code = "TX_REVERTED";
  else if (e instanceof StableNetworkError) code = "RPC_UNAVAILABLE";
  // viem BaseError (which StableError extends) exposes a concise `shortMessage`.
  const message =
    (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return ok({ code, message }, `${code}: ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools (5) — registered fresh on each per-session McpServer
// ─────────────────────────────────────────────────────────────────────────────

function registerTools(server: McpServer): void {
  // stable_transfer — write
  server.registerTool(
    "stable_transfer",
    {
      title: "Transfer USDT",
      description: "Transfer USDT to an address (testnet). Returns the transaction hash.",
      inputSchema: {
        to: ADDRESS,
        amount: AMOUNT,
        token: ADDRESS.optional(),
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
        // ASSUMPTION: TransferParams requires `from`; the shared signer is the sender.
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
      description: "Estimate the destination amount for a cross-chain USDT bridge. Read-only.",
      inputSchema: {
        // ASSUMPTION: fromChain/toChain are Chain enum *values* (e.g. "ethereum", "stable");
        // call stable_list_chains for the exact strings to pass.
        fromChain: z.nativeEnum(Chain),
        toChain: z.nativeEnum(Chain),
        fromToken: ADDRESS,
        toToken: ADDRESS,
        amount: AMOUNT,
        fromDecimals: DECIMALS.optional(),
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
      description: "Bridge USDT across chains (testnet). Call stable_quote_bridge first. Returns the source-chain transaction hash.",
      inputSchema: {
        fromChain: z.nativeEnum(Chain),
        toChain: z.nativeEnum(Chain),
        fromToken: ADDRESS,
        toToken: ADDRESS,
        amount: AMOUNT,
        fromDecimals: DECIMALS.optional(),
        recipient: ADDRESS.optional(),
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
      description: "List the supported chains and their chain IDs. Use the returned `name` values for fromChain/toChain.",
      outputSchema: {
        chains: z.array(z.object({ name: z.string(), chainId: z.number() })).optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () => {
      // ASSUMPTION: CHAIN_CONFIGS keys are Chain enum values; ChainConfig.id is the chainId.
      const chains = Object.entries(CHAIN_CONFIGS)
        .filter((entry): entry is [string, ChainConfig] => !!entry[1])
        .map(([name, cfg]) => ({ name, chainId: cfg.id }));
      return ok({ chains }, `${chains.length} chains: ${chains.map((c) => c.name).join(", ")}`);
    },
  );

  // stable_balance — read-only USDT balance on the stable chain
  server.registerTool(
    "stable_balance",
    {
      title: "Read USDT balance",
      description:
        "Read a wallet's USDT balance on the stable chain (testnet). Defaults to this server's own wallet and the chain's USDT token. Read-only.",
      inputSchema: {
        // Defaults to the server's signer address.
        address: ADDRESS.optional(),
        // Defaults to the stable chain's USDT token.
        token: ADDRESS.optional(),
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
  const server = new McpServer({ name: "stable-mcp", version: "0.1.0" });
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
