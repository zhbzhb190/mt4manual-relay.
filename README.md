# MT4Manual relay

Why it exists: MT4 EAs can only make outbound HTTP(S) calls (WebRequest), and this box has no inbound access from the internet.
So the EA on Mohammad's PC and the dashboard on the box both connect out to this small relay, and it passes data between them.

- `relay.js`: one file, no npm dependencies, Node 18+. Run it with `RELAY_TOKEN=<token> PORT=8796 node relay.js`.
- The host must provide HTTPS (MT4 WebRequest is configured for an https:// URL; the EA refuses anything else).
- Wire protocol: see the header of relay.js. EA→relay `POST /v1/ea/sync` returns pending commands as
  `id|op|ticket|symbol|type|lots|sl|tp|comment` lines. Commands not acked within 8 s are dropped, so a late order never fires.
  Command ids make execution idempotent (the EA remembers the last 64).

## Hosting options (all $0)
1. **Render free web service** (free account, no card for the free plan): New > Blueprint from a repo that contains this folder plus `render.yaml`,
   then set `RELAY_TOKEN`. URL looks like `https://mt4manual-relay.onrender.com`.
2. Any other free Node host (Fly.io, Railway trial, Koyeb free, Deno Deploy with small changes), or a Cloudflare Worker port.
3. If the box ever gets a public HTTPS URL, run it here and point the EA at that URL.

Then on the box: `BRIDGE_URL=https://<relay-host> BRIDGE_TOKEN_FILE=windows-setup/.bridge-token npm start`.
Account A becomes live and the other accounts stay mock.

Request budget: the EA syncs every 1 s when positions are open and every 3 s when idle, which is about 30-90k requests a day.
The box polls on its own loop interval.
Render free has no per-request cap. Cloudflare Workers free is capped at 100k requests a day, which is tight.
ntfy.sh was rejected because anonymous use is limited to 250 messages a day per IP.
