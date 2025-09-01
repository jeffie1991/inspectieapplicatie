// .github/scripts/apply_suggestions.js
// Node 20+
// Doel:
// - Bepaal PR nummer (workflow_dispatch input of issue_comment payload)
// - Haal base/head/branch op via GitHub API
// - Genereer diff (base..head) als context
// - Lees laatste PR-comment met "SUGGESTIONS"
// - Vraag Anthropic (Claude Sonnet 4) om ALLEEN SUGGESTIONS toe te passen,
//   en files terug te geven in <<<file:...>>> blokken
// - Schrijf files, commit & push naar PR-branch (default) of (optie) nieuwe branch+PR

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

function extractSuggestions(text) {
  // Pak sectie "SUGGESTIONS" t/m volgende kop (BLOCKERS/TESTS/SUMMARY) of einde
  // Case-insensitive. Fallback: lege string (geen suggesties gevonden).
  const re = /SUGGESTIONS[\s\S]*?(?=\n#{0,3}\s*(BLOCKERS|TESTS|SUMMARY|$))/i;
  const m = re.exec(text || "");
  return (m ? m[0] : "").trim();
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
    // Fallback op Sonnet 3.5 als 4 niet beschikbaar is
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

function anthropicText(data) {
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const prInput = process.env.PR_NUMBER;
  const createSeparatePR = (process.env.SUGGESTIONS_SEPARATE_PR || "").toLowerCase() === "true";

  if (!token) throw new Error("Missing GITHUB_TOKEN");
  if (!anthropicKey) throw new Error("Missing ANTHROPIC_API_KEY");
  if (!repo) throw new Error("Missing GITHUB_REPOSITORY");
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");

  const [owner, name] = repo.split("/");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

  let prNumber = prInput && String(prInput).trim();
  if (!prNumber) {
    if (event.pull_request?.number) prNumber = String(event.pull_request.number);
    else if (event.issue?.number && event.issue?.pull_request) prNumber = String(event.issue.number);
  }
  if (!prNumber || !/^\d+$/.test(prNumber)) {
    throw new Error("Could not determine PR number. Run via workflow_dispatch with PR number or comment '/apply-suggestions' inside a PR.");
  }

  // PR-details
  const pr = await ghJson(`https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`, token);
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

  // Check-out head branch en diff ophalen
  cp.execSync(`git fetch --no-tags --prune --depth=1 origin ${baseSha}`, { stdio: "inherit" });
  cp.execSync(`git fetch --no-tags --prune --depth=1 origin ${headSha}`, { stdio: "inherit" });
  cp.execSync(`git checkout -B "${headRef}" ${headSha}`, { stdio: "inherit" });
  cp.execSync(`git diff ${baseSha} ${headSha} --unified=0 > diff.patch`, { stdio: "inherit" });
  const diff = fs.readFileSync("diff.patch", "utf8").slice(0, 150000);

  // Laatste comment met "SUGGESTIONS" zoeken
  const comments = await ghJson(`https://api.github.com/repos/${owner}/${name}/issues/${prNumber}/comments?per_page=100`, token);
  const suggComment = [...comments].reverse().find(c => /SUGGESTIONS/i.test(c.body || ""));
  const suggestions = suggComment ? extractSuggestions(suggComment.body || "") : "";

  if (!suggestions) {
    console.log("No SUGGESTIONS section found; aborting.");
    return;
  }

  // Prompt opbouwen — ALLEEN suggesties toepassen
  const prompt = `
You are a senior engineer. APPLY ONLY the SUGGESTIONS listed below for PR #${prNumber}.
Do not change behavior beyond the suggestions. Keep security and performance budgets intact.
Return only the changed files in exact block format.

SUGGESTIONS:
${suggestions}

DIFF CONTEXT (base..head, unified=0, truncated):
${diff}

Return files in EXACT format:
<<<file:relative/path>>>
...code...
<<<endfile>>>

(Repeat per file)
`.trim();

  // Anthropic aanroepen
  const data = await callAnthropic({ prompt, apiKey: anthropicKey, model });
  const text = anthropicText(data);
  if (!text || !text.includes("<<<file:")) {
    fs.writeFileSync("claude_out.txt", text || "");
    throw new Error("No <<<file:...>>> blocks in Anthropic response. See claude_out.txt");
  }

  const count = writeFilesFromBlocks(text);
  if (!count) {
    console.log("No files written — nothing to commit.");
    return;
  }

  // Commit & push
  cp.execSync('git config user.name "ai-suggester"', { stdio: "inherit" });
  cp.execSync('git config user.email "bot@users.noreply.github.com"', { stdio: "inherit" });
  cp.execSync("git add -A", { stdio: "inherit" });
  const commitMsg = `AI: apply SUGGESTIONS for PR #${prNumber}`;
  cp.execSync(`git commit -m "${commitMsg}"`, { stdio: "inherit" });

  if (!createSeparatePR) {
    // Push naar dezelfde PR-branch -> triggert Reviewer opnieuw via "synchronize"
    cp.execSync(`git push origin "${headRef}"`, { stdio: "inherit" });
    console.log(`Pushed suggestions to ${headRef}. Reviewer will re-run on synchronize.`);
    return;
  }

  // Optioneel: aparte branch + PR aanmaken
  const suggBranch = `auto/sugg-sc-${prNumber}`;
  cp.execSync(`git checkout -b "${suggBranch}"`, { stdio: "inherit" });
  cp.execSync(`git push -u origin "${suggBranch}"`, { stdio: "inherit" });

  // Default branch ophalen
  const repoMeta = await ghJson(`https://api.github.com/repos/${owner}/${name}`, token);
  const baseDefault = repoMeta.default_branch || "main";

  // Nieuwe PR openen richting dezelfde base als oorspronkelijke PR
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({
      title: `AI: apply SUGGESTIONS for PR #${prNumber}`,
      head: suggBranch,
      base: pr.base.ref || baseDefault,
      body: `Automated SUGGESTIONS applied for PR #${prNumber}`
    })
  });
  if (!prRes.ok) {
    const txt = await prRes.text();
    throw new Error(`PR create (suggestions) failed: ${prRes.status} ${txt}`);
  }
  const newPR = await prRes.json();
  console.log(`Suggestions PR opened: #${newPR.number} ${newPR.html_url}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
