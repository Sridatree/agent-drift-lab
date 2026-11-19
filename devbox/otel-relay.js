// Forwards Claude Code's OTLP/HTTP JSON from 127.0.0.1:4318 inside the box to the collector, and
// drops the attributes that identify the account (email, account and organization ids) on the way
// out. Sessions still group by session.id, so the alerts work the same; the dashboards just never
// show who was logged in.
//
// It also forwards only the events the alerts read: what the agent was asked, what it said, the
// tools it ran and what they returned, and what the guard refused. Startup and API housekeeping
// (plugin loads, MCP connections, auth, every API request) never reach Loki. DEVBOX_OTEL_ALL=1
// forwards everything.
const http = require("http");

const [host, port] = process.argv[2].split(":");
const REDACT = new Set(["user.email", "user.account_uuid", "user.account_id", "user.id", "organization.id"]);
const KEEP = new Set(["user_prompt", "assistant_response", "tool_decision", "tool_result", "api_refusal", "guard_blocked"]);
const keepAll = process.env.DEVBOX_OTEL_ALL === "1";

function eventName(record) {
  const a = (record.attributes || []).find((x) => x && x.key === "event.name");
  return a && a.value && a.value.stringValue;
}

function scrub(node) {
  if (Array.isArray(node)) {
    node.forEach(scrub);
  } else if (node && typeof node === "object") {
    if (Array.isArray(node.attributes)) {
      node.attributes = node.attributes.filter((a) => !REDACT.has(a && a.key));
    }
    if (!keepAll && Array.isArray(node.logRecords)) {
      node.logRecords = node.logRecords.filter((r) => KEEP.has(eventName(r)));
    }
    Object.values(node).forEach(scrub);
  }
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    if ((req.headers["content-type"] || "").includes("json")) {
      try {
        const doc = JSON.parse(body);
        scrub(doc);
        body = Buffer.from(JSON.stringify(doc));
      } catch {
        // Not JSON after all: pass it through untouched.
      }
    }
    const headers = { ...req.headers, host: `${host}:${port}`, "content-length": body.length };
    const up = http.request({ host, port: Number(port), method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end(body);
  });
}).listen(4318, "127.0.0.1");
