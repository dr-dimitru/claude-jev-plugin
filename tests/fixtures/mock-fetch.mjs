import fs from "node:fs";

const capturePath = process.env.CLAUDE_JEV_TEST_CAPTURE;
const responseBody = process.env.CLAUDE_JEV_TEST_RESPONSE ?? "";
const status = Number(process.env.CLAUDE_JEV_TEST_STATUS ?? "200");

globalThis.fetch = async (_url, init) => {
  if (capturePath) {
    fs.writeFileSync(capturePath, String(init?.body ?? ""), "utf8");
  }
  return new Response(responseBody, {
    status,
    headers: { "Content-Type": status >= 400 ? "text/plain" : "application/json" },
  });
};
