// .github/scripts/implementer.js
// Node 18+ (liefst 20). Doet:
// - Issue payload lezen
// - Prompt bouwen
// - Anthropic aanroepen
// - <<<file:...>>> blokken naar schijf schrijven
// - <<<commands>>> (optioneel) naar commands.txt

const fs = require("fs");

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");
  if (!anthropicKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue || !issue.body) {
    throw new Error("No issue body found. This workflow should be triggered by an Issue event.");
  }

  const spec = issue.body;

  const prompt = `
You are Claude Code. Implement the SPEC CARD by returning a set of files with this exact format:

<<<file:relative/path>>>
...code...
<<<endfile>>>

(Repeat per file)
Then a section:
<<<commands>>>
one shell command per line
<<<endcommands>>>

NO explanations. SPEC:

${spec}
`.trim();

  // Call Anthropic Messages API
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-latest",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic request failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  // Anthropic content blocks -> concat text
  const parts = Array.isArray(data.content) ? data.content : [];
  const text = parts
    .filter(p => p && p.type === "text" && typeof p.text === "string")
    .map(p => p.text)
    .join("");

  if (!text || !text.includes("<<<file:")) {
    fs.writeFileSync("claude_out.txt", text || "");
    throw new Error("No <<<file:...>>> blocks returned by Anthropic. See claude_out.txt for raw output.");
  }

  // Parse files
  const fileRegex = /<<<file:(.+?)>>>\n([\s\S]*?)\n<<<endfile>>>/g;
  let m;
  let count = 0;
  while ((m = fileRegex.exec(text)) !== null) {
    const relPath = m[1].trim();
    const code = m[2];
    const path = require("path");
    const full = path.resolve(process.cwd(), relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, code, "utf8");
    count++;
  }

  // Parse optional commands
  const cmdMatch = text.match(/<<<commands>>>\n([\s\S]*?)\n<<<endcommands>>>/);
  fs.writeFileSync("commands.txt", cmdMatch ? cmdMatch[1] : "", "utf8");

  console.log(`Wrote ${count} file(s) from Claude output.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
