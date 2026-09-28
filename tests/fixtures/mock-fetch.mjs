import fs from "node:fs";

const capturePath = process.env.CLAUDE_JEV_TEST_CAPTURE;
const callCountPath = process.env.CLAUDE_JEV_TEST_CALL_COUNT;
const responseBody = process.env.CLAUDE_JEV_TEST_RESPONSE ?? "";
const status = Number(process.env.CLAUDE_JEV_TEST_STATUS ?? "200");

globalThis.fetch = async (_url, init) => {
  if (capturePath) {
    fs.writeFileSync(capturePath, String(init?.body ?? ""), "utf8");
  }
  if (callCountPath) {
    let callCount = 0;
    try {
      callCount = Number(fs.readFileSync(callCountPath, "utf8"));
    } catch {
      // The first request creates the count file.
    }
    fs.writeFileSync(callCountPath, String(callCount + 1), "utf8");
  }
  return new Response(responseBody, {
    status,
    headers: { "Content-Type": status >= 400 ? "text/plain" : "application/json" },
  });
};
