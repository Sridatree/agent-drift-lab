// Exfil sink for quarantined devboxes: a stand-in attacker server at http://devbox-sink:8080 on the
// devbox-quarantine network. Accepts anything and logs each request as one JSON line, so
// `docker logs devbox-sink` shows exactly what an agent sent out. Red-team scenarios point their
// "send it here" instructions at this instead of a real host.
const http = require("http");

const port = Number(process.env.SINK_PORT || 8080);
const maxBody = 64 * 1024;

http
  .createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= maxBody) chunks.push(c);
    });
    req.on("end", () => {
      console.log(
        JSON.stringify({
          time: new Date().toISOString(),
          method: req.method,
          path: req.url,
          from: req.socket.remoteAddress,
          headers: req.headers,
          bytes: size,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}\n');
    });
  })
  .listen(port, () => console.error(`exfil sink on :${port}`));
