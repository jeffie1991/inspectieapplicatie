// .github/scripts/fix_blockers.js
// Node 20+ (GitHub runners). Doel:
// - Bepaal PR nummer (workflow_dispatch input of issue_comment payload)
// - Haal base/head/branch op via GitHub API
// - Genereer diff (base..head)
// - Lees laatste PR-comment met "BLOCKERS"
// - Vraag Anthropic (Claude Sonnet 4) om fixes in <<<file:...>>> blokken
// - Schrijf files, commit & push naar PR-branch

const fs = require("fs");
const cp = require("child_process");
const path = require("path");

async function ghJson(url, token) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractBlockersFromText(text) {
  // Zoek "BLOCKERS" sectie (case-insensitive) tot volgende kop (SUGGESTIONS/TESTS/Summary) of einde
  // Fallback: hele comment
  const re = /BLOCKERS[\s\S]*?(?=\n#{0,3}\s*(SUGGESTIONS|TESTS|SUMMARY|$))/i;
  const m = re.exec(text);
  return (m ? m[0] : text).trim();
}

async function callAnthropic({ prompt, apiKey, model }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (res.status === 404) {
    const fb = "claude-3-5-sonnet-20241022";
    const r2 = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: fb,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt + `\n\n(Using fallback: ${fb})` }]
      })
    });
    if (!r2.ok) throw new Error(`Anthropic fallback failed: ${r2.status} ${await r2.text()}`);
    return r2.json();
  }
  if (!res.ok) throw new Error(`Anthropic failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function anthropicTextPayload(data) {
  const parts = Array.isArray(data.content) ? data.content : [];
  return parts.filter(p => p.type === "text").map(p => p.text || "").join("");
}

function writeFilesFromBlocks(text) {
  const fileRegex = /<<<file:(.+?)>>>\n([\s\S]*?)\n<<<endfile>>>/g;
  let m, count = 0;
  while ((m = fileRegex.exec(text)) !== null) {
    const rel = m[1].trim();
    const code = m[2];
    const full = path.resolve(process.cwd(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, code, "utf8");
    count++;
    console.log("Wrote:", rel);
  }
  fs.writeFileSync(
    "commands.txt",
    (text.match(/<<<commands>>>\n([\s\S]*?)\n<<<endcommands>>>/) || [,""])[1],
    "utf8"
  );
  return count;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const openai = process.env.OPENAI_API_KEY; // not used here, but reserved if you later add GPT
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  const repo = process.env.GITHUB_REPOSITORY; // owner/repo
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const prInput = process.env.PR_NUMBER; // from workflow_dispatch

  if (!token) throw new Error("Missing GITHUB_TOKEN");
  if (!anthropicKey) throw new Error("Missing ANTHROPIC_API_KEY");
  if (!repo) throw new Error("Missing GITHUB_REPOSITORY");
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");

  const [owner, name] = repo.split("/");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

  let prNumber = prInput;
  if (!prNumber) {
    // Pull from event payload (issue_comment or pull_request)
    if (event.pull_request?.number) prNumber = String(event.pull_request.number);
    else if (event.issue?.number && event.issue?.pull_request) prNumber = String(event.issue.number);
  }
  if (!prNumber) throw new Error("Could not determine PR number. Set PR_NUMBER input for workflow_dispatch or run on PR/issue_comment.");

  // Get PR details
  const pr = await ghJson(`https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`, token);
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

  // Fetch base & head, checkout head branch
  cp.execSync(`git fetch --no-tags --prune --depth=1 origin ${baseSha}`, { stdio: "inherit" });
  cp.execSync(`git fetch --no-tags --prune --depth=1 origin ${headSha}`, { stdio: "inherit" });
  cp.execSync(`git checkout -B "${headRef}" ${headSha}`, { stdio: "inherit" });

  // Generate diff (unified=0)
  cp.execSync(`git diff ${baseSha} ${headSha} --unified=0 > diff.patch`, { stdio: "inherit" });
  const diff = fs.readFileSync("diff.patch","utf8").slice(0, 150000);

  // Load latest issue comment that contains "BLOCKERS"
  const comments = await ghJson(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`, token);
  const blockerComment = [...comments].reverse().find(c => /BLOCKERS/i.test(c.body || ""));
  const blockers = blockerComment ? extractBlockersFromText(blockerComment.body || "") : "";

  if (!blockers) {
    console.log("No BLOCKERS section found; aborting.");
    return;
  }

  // Build prompt for Anthropic
  const prompt = `
You are a senior engineer. FIX ONLY the BLOCKERS listed below for PR #${prNumber}, and return files in blocks.

Constraints:
- Modify only what's needed to resolve the blockers.
- Keep structure & conventions.
- Keep security (Firestore Rules, signed URLs) and performance budgets.
- Do NOT include explanations. Return only files in blocks.

BLOCKERS:
${blockers}

DIFF (base..head, unified=0, truncated):
${diff}

Return files in EXACT format:
<<<file:relative/path>>>
...code...
<<<endfile>>>

(Repeat per file)
`.trim();

  // Call Anthropic and write files
  const data = await callAnthropic({ prompt, apiKey: anthropicKey, model });
  const text = anthropicTextPayload(data);
  if (!text || !text.includes("<<<file:")) {
    fs.writeFileSync("claude_out.txt", text || "");
    throw new Error("No <<<file:...>>> blocks in Anthropic response. See claude_out.txt");
  }
  const count = writeFilesFromBlocks(text);
  if (!count) {
    console.log("No files written — nothing to commit.");
    return;
  }

  // Commit & push to same PR branch (headRef)
  cp.execSync('git config user.name "ai-fixer"', { stdio: "inherit" });
  cp.execSync('git config user.email "bot@users.noreply.github.com"', { stdio: "inherit" });
  cp.execSync("git add -A", { stdio: "inherit" });
  cp.execSync(`git commit -m "AI: fix BLOCKERS for PR #${prNumber}"`, { stdio: "inherit" });
  cp.execSync(`git push origin "${headRef}"`, { stdio: "inherit" });

  console.log(`Pushed fixes to ${headRef}. Reviewer will re-run on synchronize.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
