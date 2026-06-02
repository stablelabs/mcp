# Testing stable-mcp

Two ways to test. Start with the script — it proves the server is correct in ~10 seconds.
Then use the UI to actually click the tools.

> All scripts live in `packages/mcp/scripts/` and free the port / build / clean up on their own.
> You never need to copy-paste commands out of this file.

---

## 1. Automated check (no funds) — `scripts/smoke.sh`

```
bash scripts/smoke.sh
```

It builds, boots the server on port 3111 with a throwaway key, and runs 15 checks.
You'll see a `PASS`/`FAIL` line per check and a final `ALL GREEN` or `SOME CHECKS FAILED`.
Exit code is `0` only when everything passes (so CI can use it).

What each check proves:

| Check | Proves |
|-------|--------|
| `mainnet refused` | boot guard: server won't start off testnet |
| `1. no token -> 401` | auth is enforced |
| `1b. bad Host -> 403` | DNS-rebinding protection is on |
| `2. initialize -> session id` | stateful session is created |
| `3. initialized -> 202` | lifecycle handshake works |
| `4. tools/list -> 4 tools` | all 4 tools registered |
| `5. list_chains -> chains[]` | a read-only tool actually runs |
| `6. bad address rejected` | Zod input validation works |
| `7. bad protocol version -> 400` | spec version guard |
| `8a/8b. DELETE -> 200, reuse -> 404` | session termination + eviction |

Change the port if 3111 is busy: `PORT=4000 bash scripts/smoke.sh`.

---

## 2. UI testing — `scripts/serve-for-ui.sh` + MCP Inspector

The **MCP Inspector** is the official browser tool for poking at an MCP server by hand.
This script boots stable-mcp *and* launches the Inspector for you.

### Start it

No funds (read-only tools work, writes will return an error you can read):
```
bash scripts/serve-for-ui.sh
```

With your funded testnet key (transfer/bridge will send real testnet txns):
```
STABLE_PRIVATE_KEY=0xYOUR_TESTNET_KEY bash scripts/serve-for-ui.sh
```

The script prints a box with the exact connection values, then opens the Inspector
in your browser (usually `http://localhost:6274`). If a browser tab doesn't open,
copy the `http://localhost:6274/?...` URL the Inspector prints in the terminal —
it already includes the proxy auth token.

### Connect (left-hand panel)

1. **Transport Type** dropdown → choose **`Streamable HTTP`**.
   *(Not "STDIO" and not "SSE" — it must be Streamable HTTP.)*
2. **URL** field → paste `http://localhost:3111/mcp`
   *(the script prints this; note the `/mcp` path).*
3. Find **Authentication** / **Header** section (sometimes under an
   "Authentication" expander). Add **one header**:
   - **Header Name:** `Authorization`
   - **Header Value:** `Bearer ui-token-123`
     *(use whatever token the script's box shows; default is `ui-token-123`).*
4. Click **`Connect`**.
   - ✅ Success: the status dot turns **green / "Connected"** and the top tabs
     (Resources, Prompts, **Tools**, …) become clickable.
   - ❌ If you forget the header you'll see **401**; a wrong URL/path shows a
     connection error. Fix the field and click **Connect** again.

### List the tools

5. Click the **`Tools`** tab, then **`List Tools`**.
   You should see exactly **4**:
   - `stable_transfer` (badge: destructive)
   - `stable_quote_bridge` (badge: read-only)
   - `stable_bridge` (badge: destructive)
   - `stable_list_chains` (badge: read-only)

### Run a tool (read-only first — always works, no funds)

6. Click **`stable_list_chains`** in the list → its form appears on the right
   (no inputs) → click **`Run Tool`** / **`Call Tool`**.
   - In the **result** panel you'll see **Structured Content** like
     `{ "chains": [ { "name": "sepolia", "chainId": 11155111 }, … ] }`
     plus a one-line text summary.
   - 👉 **Copy the `name` values** (`sepolia`, `stable-testnet`, …). You pass these
     verbatim as `fromChain` / `toChain` below — use the lowercase string exactly,
     **not** a capitalized label.

7. Click **`stable_quote_bridge`** → fill the form:
   - `fromChain`: pick/enter a `name` from step 6 (e.g. `ethereum`)
   - `toChain`: another `name` (e.g. `stable`)
   - `fromToken`: a `0x…` token address (40 hex chars)
   - `toToken`: a `0x…` token address
   - `amount`: `1`
   - leave `fromDecimals` empty
   - **`Run Tool`** → result shows `{ "toAmount": <number> }`.
   - If you typed a bad address, the Inspector shows a **validation error**
     ("must be a 0x-prefixed 40-hex address") *before* anything is sent — that's
     the Zod schema doing its job.

### Run a write tool (needs a funded testnet key)

> Only do this if you started the script with `STABLE_PRIVATE_KEY=0xYOUR_TESTNET_KEY`.
> The shared key is the sender; anyone connected can move its funds — testnet only.

8. Click **`stable_transfer`** → fill:
   - `to`: a `0x…` recipient address
   - `amount`: `1`
   - leave `token` / `tokenDecimals` empty (defaults to native USDT)
   - **`Run Tool`**.
   - ✅ Funded: result has `{ "txHash": "0x…" }` — paste that into the testnet
     explorer to confirm it landed.
   - ⚠️ Unfunded / RPC issue: result has `{ "code": "...", "message": "..." }`
     where `code` is one of `INVALID_INPUT`, `QUOTE_FAILED`, `TX_REVERTED`,
     `RPC_UNAVAILABLE`, `STABLE_ERROR`. This is the expected, readable error path
     — the tool call still "succeeds" at the protocol level and returns the code.

9. **`stable_bridge`** → same fields as the quote (step 7) plus optional
   `recipient`. Run a quote first, then bridge. Result: source-chain `{ "txHash" }`.

### Stop

Press **`Ctrl-C`** once in the terminal running the script — it stops both the
server and the Inspector.

---

## Notes / gotchas

- **`ALLOWED_HOSTS` must match the Host you connect with.** The scripts set it to
  `localhost:<PORT>` for you. If you point the Inspector at `127.0.0.1` instead of
  `localhost`, add `127.0.0.1:<PORT>` to `ALLOWED_HOSTS` or you'll get **403**.
- **Single instance only.** Sessions live in memory; don't run two copies behind a
  load balancer in MVP.
- **Testnet only.** The server refuses to boot unless `STABLE_NETWORK=testnet`.
