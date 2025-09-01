// .github/scripts/reviewer.js
// Node 20+ required (fetch is built-in)

const fs = require("fs");

async function main() {
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  const token = process.env.GITHUB_TOKEN;
  const openaiKey = process.env.OPENAI_API_KEY;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token) throw new Error("Missing GITHUB_TOKEN");
  if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");

  // Haal PR nummer uit event payload
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const prNumber = event.pull_request?.number;
  if (!prNumber) throw new Error("No pull_request.number found in event payload");

  // Lees diff (gemaakt in de workflow stap)
  const diff = fs.readFileSync("diff.patch", "utf8").slice(0, 200000);

  const prompt = [
    "You are a Staff Engineer. Review this diff for correctness, security (Firebase Rules, signed URLs),",
    "performance (PDF/IFC budgets), accessibility, and test coverage.",
    "Return ONLY markdown with:",
    "1) SUMMARY",
    "2) BLOCKERS (must fix)",
    "3) SUGGESTIONS",
    "4) TESTS to add.",
    "",
    "Diff:",
    diff
  ].join("\n");

  // Call OpenAI
  const body = {
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI request failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  const review = json?.choices?.[0]?.message?.content || "No content from OpenAI.";

  // Post comment naar PR
  const [owner, repoName] = repo.split("/");
  const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json"
    },
    body: JSON.stringify({ body: review })
  });

  if (!ghRes.ok) {
    const text = await ghRes.text();
    throw new Error(`GitHub comment failed: ${ghRes.status} ${text}`);
  }

  console.log("Review comment geplaatst op PR #" + prNumber);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
