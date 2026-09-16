import express from "express";

const app = express();

// Skeleton health check — proves the server is up. No rate limiting yet.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Bouncer listening on :${port}`);
});
