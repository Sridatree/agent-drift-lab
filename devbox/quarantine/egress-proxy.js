// Egress proxy for quarantined devboxes: the only way out of the internal devbox-quarantine
// network. Tunnels HTTPS (CONNECT) and forwards plain HTTP to hosts on EGRESS_ALLOW, refuses the
// rest, and logs every attempt as one JSON line, so `docker logs devbox-egress` is the record of
// everything the box tried to reach.
//
// EGRESS_ALLOW is a comma-separated list of host names; an entry also allows its subdomains.
// EGRESS_ALLOW_FILE adds the hosts in that file, one per line (# starts a comment). It is re-read
// whenever it changes, so `devbox allow HOST` opens a host for boxes that are already running.
// EGRESS_DENY (same format) always wins, "*" included.
// "*" allows the whole internet, still logged, but never a host that resolves to a private,
// loopback, link-local or CGNAT address: with the internet open, the LAN, a VPN into the office
// or a Tailscale net is where real damage would be.
//
// EGRESS_OTLP (host:port) is where telemetry goes. Claude's OTLP exporter ignores NO_PROXY and
// asks this proxy for localhost:4318, which from here would be the proxy itself, so that one
// destination is rerouted to the collector instead of refused.
const http = require("http");
const net = require("net");
const dns = require("dns").promises;

const fs = require("fs");

const baseAllow = (process.env.EGRESS_ALLOW || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const allowFile = process.env.EGRESS_ALLOW_FILE || "";
let allow = baseAllow;
let allowFileStamp = null;
// Cheap enough per request: one stat, and a read only when the file changed.
const refreshAllow = () => {
  if (!allowFile) return;
  let stamp = "missing";
  try {
    const st = fs.statSync(allowFile);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {}
  if (stamp === allowFileStamp) return;
  allowFileStamp = stamp;
  let extra = [];
  try {
    extra = fs.readFileSync(allowFile, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
      .filter(Boolean);
  } catch {}
  allow = [...new Set([...baseAllow, ...extra])];
  console.error(`egress proxy: allow=${allow.join(",")}`);
};
refreshAllow();
const port = Number(process.env.EGRESS_PORT || 3128);

const deny = (process.env.EGRESS_DENY || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const matches = (list, host) => list.some((a) => host === a || host.endsWith("." + a));
const allowAll = () => allow.includes("*");
const allowed = (host) => {
  refreshAllow();
  return !matches(deny, host) && (allowAll() || matches(allow, host));
};

const privateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
};

// Resolve once and connect to that address, so a name cannot pass the check and then re-resolve
// to somewhere private. Returns the address to use, or null when the host must be refused.
const resolveAllowed = async (host) => {
  if (!allowed(host)) return null;
  if (!allowAll()) return host;
  try {
    const { address } = await dns.lookup(host);
    return privateAddress(address) ? null : address;
  } catch {
    return null;
  }
};

const [otlpHost, otlpPort] = (process.env.EGRESS_OTLP || "").split(":");
const otlpTarget = (host, targetPort) =>
  otlpHost && targetPort === 4318 && (host === "localhost" || host === "127.0.0.1")
    ? { host: otlpHost, port: Number(otlpPort || 4318) }
    : null;

const log = (verdict, method, host, targetPort, client) =>
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      verdict,
      method,
      host,
      port: targetPort,
      client,
    }),
  );

const server = http.createServer(async (req, res) => {
  // Plain HTTP through the proxy arrives with an absolute URL.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end("absolute URL required\n");
    return;
  }
  let host = url.hostname.toLowerCase();
  let targetPort = Number(url.port || 80);
  const otlp = otlpTarget(host, targetPort);
  let address = host;
  if (otlp) {
    ({ host, port: targetPort } = otlp);
    address = host;
  } else if (!(address = await resolveAllowed(host))) {
    log("deny", req.method, host, targetPort, req.socket.remoteAddress);
    res.writeHead(403).end(`egress to ${host} blocked by devbox quarantine\n`);
    return;
  }
  if (!otlp) log("allow", req.method, host, targetPort, req.socket.remoteAddress);
  const upstream = http.request(
    { host: address, port: targetPort, path: url.pathname + url.search, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => res.destroy());
  req.pipe(upstream);
});

server.on("connect", async (req, client, head) => {
  // Attached first: a refused client that resets its socket must not take the proxy down.
  client.on("error", () => {});
  const [rawHost, rawPort] = req.url.split(":");
  let host = (rawHost || "").toLowerCase();
  let targetPort = Number(rawPort || 443);
  const otlp = otlpTarget(host, targetPort);
  let address = host;
  if (otlp) {
    ({ host, port: targetPort } = otlp);
    address = host;
  } else if (!(address = await resolveAllowed(host))) {
    log("deny", "CONNECT", host, targetPort, client.remoteAddress);
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (!otlp) log("allow", "CONNECT", host, targetPort, client.remoteAddress);
  const upstream = net.connect(targetPort, address, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

// One bad connection must never stop the only exit out of quarantine.
server.on("clientError", (_err, socket) => socket.destroy());
process.on("uncaughtException", (err) => console.error(`egress proxy: ${err.message}`));

server.listen(port, () => console.error(`egress proxy on :${port}, allow=${allow.join(",")}`));
