---
summary: Provision, deploy, verify, rotate, inspect, and roll back the anonymous, budget-limited ACP-Rad demonstration on Vercel Services.
read_when: Deploying to Vercel, changing admission or model spend, inspecting hosted audit, or responding to a failed production smoke.
---

# Vercel demo deployment

This is an anonymous public **synthetic-data demo**, not a clinical deployment. Never paste or dictate PHI. Anyone who reaches the URL can start an agent; the 10-socket Redis limit and $10/day Gateway key are the resource boundaries.

## Hosted shape

```text
one Vercel origin
├── /*                  → editor service (Vite)
├── /health             → bridge service
└── /acp                → anonymous, same-origin WebSocket
                            ├── Redis admission (10 global leases)
                            └── Python agent → Vercel AI Gateway
```

`vercel.json` is the deploy contract. The project root must be the repository root and Framework Preset must be **Services**. Specific rewrites precede the editor catch-all. The bridge runs in Singapore (`sin1`), accepts at most ten requests per instance, and separately enforces ten open agent sockets globally through Redis.

Vercel container Functions scale down and impose a maximum invocation duration. A disconnected editor never reconnects automatically: the radiologist clicks **Reconnect agent**, which creates a fresh ACP and model session while keeping the current browser report, transcript, flags, and audit mirror.

## One-time provisioning

Run from the repository root. The linked project is `lightbridge-ks-projects/acp-rad-demo-editor`.

1. In Vercel Project Settings → Build and Deployment:

   - Root Directory: `.` (repository root)
   - Framework Preset: `Services`
   - Do not set `VITE_BRIDGE_URL`.

2. Provision one Upstash Redis resource and connect it to this project for **Production and Preview**:

   ```sh
   vercel integration add upstash
   ```

   The code accepts `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` and the Marketplace aliases `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Confirm both target environments receive a URL and token. Do not put either value in git.

3. Create a dedicated Gateway key with a hard daily budget:

   ```sh
   vercel ai-gateway api-keys create \
     --name acp-rad-demo-production \
     --budget 10 \
     --refresh-period daily
   ```

   The daily window resets in UTC. Add the returned value only as Production `AI_GATEWAY_API_KEY`; Preview must not have this variable. In AI Gateway billing, keep automatic credit top-up disabled unless KS deliberately changes that policy. The per-key quota is the workload boundary even if team credits exist.

## Environment matrix

| Variable | Production | Preview | Notes |
|---|---:|---:|---|
| Redis REST URL/token | secret | secret | injected by Upstash Marketplace |
| `DEMO_LLM_ENABLED` | `true` | `false` | Preview admission closes `4403` |
| `AI_GATEWAY_API_KEY` | secret | **absent** | dedicated $10/day key |
| `RAD_MODEL` | `openai/gpt-5.6-terra` | same or absent | exact Gateway model id |
| `RAD_MODEL_BASE_URL` | `https://ai-gateway.vercel.sh/v1` | same or absent | required when Production LLM is on |
| `PORT` | `8787` | `8787` | matches the container `EXPOSE` and health check |
| `VERCEL_SUPPORT_MAX_CONCURRENCY` | `1` | `1` | opts the beta container function into `maxConcurrency` |
| `ACTIVE_SESSION_LIMIT` | `10` | `10` | open anonymous agent WebSockets |
| `AUDIT_RETENTION_SECONDS` | `604800` | `604800` | rolling seven days |

Defaults are 90-second leases renewed every 30 seconds. They can be made explicit with `SESSION_LEASE_TTL_SECONDS=90` and `SESSION_LEASE_HEARTBEAT_SECONDS=30`.

The bridge fails at startup if a Vercel deployment lacks Redis configuration, or if Production enables the LLM without the Gateway key and exact base URL. `OPENAI_API_KEY` remains a local/direct-provider fallback; do not configure it on Vercel, because that would create an unintended credential path.

## Preview rollout

Deploy a branch before changing Production:

```sh
vercel deploy
```

Verify through the Preview URL:

- the editor opens without a login and `/health` returns `{"status":"ok"}`;
- correct-origin `/acp` closes `4403` because Preview inference is disabled;
- eleven anonymous socket attempts admit ten and close the eleventh with `4429` without spawning an agent;
- Redis failure closes admission with `1013`;
- a forced disconnect cancels unfinished proposals, leaves the report/transcript/audit visible, and shows **Reconnect agent**.

## Production rollout

Before deployment, confirm the Gateway key says **$10 / daily**, Preview has no copy, and the team still holds **purchased AI Gateway credits** (paid tier).

Verify model access by *calling* the model, never by listing it. `GET /v1/models` returns the entire catalogue regardless of entitlement, so a model the key may not call is listed exactly like one it may:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://ai-gateway.vercel.sh/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5.6-terra","messages":[{"role":"user","content":"ping"}],"max_tokens":1}'
```

`200` is the only pass; read any other status against the Gateway failure table below.

Deploy only after the dry gates and Preview checks pass:

```sh
vercel deploy --prod
```

Then open `https://acp-rad-demo-editor.vercel.app` and:

1. Open one synthetic fixture and run `/impression`.
2. Accept one proposal and confirm the report changes only through the human gate.
3. Confirm the Redis `acp-rad:production:audit:<accession>` list contains the audit records and has a TTL near 604800 seconds.
4. Inspect Vercel runtime logs: methods/statuses are allowed; Redis tokens, Gateway keys, prompts, and report content must be absent.
5. Confirm AI Gateway usage is attributed to `acp-rad-demo-production` and counts against its daily quota.

### Gateway failure modes

Every one of these surfaces only as a failed `session/prompt`. **The transport succeeds first** — `/acp` upgrades, the agent spawns, `initialize` and `session/new` complete — so the editor and editor-only commands stay available and the browser console shows nothing relevant. Read `vercel logs <deployment-url>`; do not debug this from the browser.

| Status | Gateway error | Meaning | Action |
|---|---|---|---|
| `402` | payment required | the daily key budget or the credit balance is exhausted | wait for the UTC reset, or have KS explicitly approve a new limit |
| `403` | `RestrictedModelsError` / `no_providers_available` | the team is on the **free tier** and this model sits outside the free subset | KS purchases AI Gateway credits — a per-key budget caps spend but grants no credits and does not leave the free tier |
| `429` | rate limited | free-tier per-model rate limit | retry after a short wait; the paid tier raises the limit |

Budget exhaustion is expected to leave the editor and editor-only commands working. Do not silently add a direct-provider key or raise the quota.

## Credential rotation

- **Gateway key:** create a new dedicated budgeted key, replace Production `AI_GATEWAY_API_KEY`, redeploy and smoke, then revoke the old key.
- **Redis token:** rotate in Upstash, confirm Marketplace variables update, redeploy both environments, then revoke the old token.

Never print current secret values while inspecting configuration. `vercel env ls` is safe; `vercel env pull` writes secrets to a local file and should be used only when deliberately debugging, with the output remaining gitignored.

## Audit inspection

Hosted keys are environment-scoped:

```text
acp-rad:production:audit:<safe-accession>
acp-rad:preview:audit:<safe-accession>
```

Use the Upstash console to inspect `LRANGE <key> 0 -1` and `TTL <key>`. Audit persistence is best-effort demonstration telemetry and contains role stubs, not authenticated people. Delete keys from Upstash if a synthetic demo needs an early purge. Local/Compose audit remains JSONL in the `audit-data` volume.

## Rollback

If the Production smoke fails:

1. In Vercel Deployments, promote the immediately previous known-good deployment (or use the documented Vercel rollback command for that deployment).
2. Revoke the new Gateway key so a broken route cannot spend.
3. Leave Preview live only if its no-LLM safeguards work; otherwise roll it back too.
4. Record whether failure was build/routing, startup configuration, Redis admission, WebSocket duration, or Gateway/model access before retrying — `vercel logs <deployment-url>` is the only place the last of these is visible.

The old frontend-only deployment cannot provide the LLM. Rolling back to it is safe for spend but deliberately returns the editor to agent-unavailable behavior.

## References

- [Vercel Services guide](https://vercel.com/kb/guide/vercel-services)
- [Running Docker on Vercel](https://vercel.com/kb/guide/docker)
- [Redis on Vercel](https://vercel.com/docs/redis)
- [AI Gateway key budgets](https://vercel.com/changelog/budgets-for-api-keys-on-ai-gateway)
- [AI Gateway OpenAI-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis)
