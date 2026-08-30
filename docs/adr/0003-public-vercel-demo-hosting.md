---
summary: ADR — host the small anonymous public demo as one Vercel Services project with Redis admission/audit and a budgeted Production-only AI Gateway key.
read_when: Changing public deployment, WebSocket admission, Redis retention, model credentials, or demo spending controls.
---

# ADR 0003 — Public demo hosting on Vercel Services

**Status:** accepted 2026-08-30; amended the same day to remove passphrase authentication (KS). **Amends:** system design §2–3 and data design §2–3, §7–8.

## Context

The existing Vercel project serves only the Vite editor. Its browser attempts a same-origin `/acp` WebSocket, but no bridge or Python agent exists in that deployment. A demo for fewer than 20 radiologists needs working inference without exposing a provider key to the browser or allowing unbounded public use. It remains a synthetic-data demonstration, not a clinical system.

## Decision

Deploy the repository as one Vercel **Services** project:

- `editor`: the Vite static build, catch-all public service.
- `bridge`: the existing final Dockerfile stage, exposed at `/acp` and `/health`, in `sin1`, with the plan maximum duration and per-instance concurrency 10.
- The browser resolves HTTP and WebSocket endpoints from its own origin. No `VITE_BRIDGE_URL` is set on Vercel.

The demo is intentionally anonymous: loading the public URL requires no login. The bridge remains the resource-admission boundary: it checks the WebSocket Origin and acquires a Redis lease before starting an agent. Redis atomically enforces at most ten open agent WebSockets across instances and retains audit lists for seven days. If the admission store cannot answer, admission fails closed.

Production inference goes only through a dedicated Vercel AI Gateway key for `openai/gpt-5.6-terra`, capped at **$10 per day**. Preview deliberately has no Gateway credential and closes agent WebSockets with `4403`. The bridge refuses to start on Vercel when Redis or required Production Gateway configuration is absent.

WebSocket/container recycling is expected. The editor keeps the current report, transcript, flags, and audit mirror; cancels unfinished proposals; and presents **Reconnect agent**. Reconnect is never automatic and always creates a new ACP/agent session.

## Why

- One origin keeps cookies and WebSockets simple and avoids CORS or a browser-visible backend address.
- A container preserves the Node-to-Python stdio architecture instead of porting the agent into a different runtime.
- A Redis lease is the global authority; Vercel instance concurrency is only a second, local-cost guard.
- A scoped Gateway key with a hard daily budget limits the blast radius independently of general Vercel billing.
- Anonymous access removes coordination friction for the short-lived demo; Redis concurrency and the Gateway key budget, rather than identity, are the abuse and spend boundaries.

## Rejected alternatives

- **Frontend-only Vercel plus a browser provider key:** leaks the key and cannot host the stdio agent.
- **Separate public bridge origin:** adds CORS, cookie-domain, preview URL, and TLS coordination without benefit for this demo.
- **In-memory capacity accounting:** cannot enforce ten sessions across scaled instances and loses rate-limit state on recycle.
- **Automatic reconnect:** can create surprise model spend and makes a new agent session look continuous when its memory is not.
- **Shared-passphrase login:** initially accepted, then removed by KS before rollout. It adds distribution and reset friction without providing named identity; the demo accepts anonymous access within its hard capacity and spend ceilings.
- **Google OAuth/Firebase Auth now:** stronger named identity, but more setup and user-data handling than this under-20-person demonstration needs. Revisit if access becomes ongoing or attribution is required.

## Consequences

- Vercel Services and container images are beta platform dependencies; maximum connection duration and scale-in remain external limits.
- Anyone who can reach the public URL can start an agent until the 10-socket capacity or $10/day Gateway budget is exhausted. There is no individual attribution; audit actor values remain role stubs.
- Redis audit is demo telemetry, not a medical audit system: delivery is best-effort, retention is seven days, and no PHI is allowed.
- Preview can validate access, routing, Redis, capacity, and reconnect behavior but cannot exercise a live model.
