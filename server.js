const http = require("http");

const PORT = process.env.PORT || 3000;
const PR_SHA = process.env.GITHUB_SHA || "unknown";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem;">
        <h1>PR Preview Environment is live 🎉</h1>
        <p>This instance was auto-provisioned for a pull request.</p>
        <p>Commit: ${PR_SHA}</p>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`Preview app listening on port ${PORT}`);
});
