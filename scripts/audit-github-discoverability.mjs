import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const keywordsPath = new URL("../discovery-keywords.json", import.meta.url);
const catalogPath = new URL("../ecosystem.json", import.meta.url);
const outputDirectory = new URL("../artifacts/", import.meta.url);
const reportPath = new URL("../artifacts/github-discoverability.json", import.meta.url);
const summaryPath = new URL("../artifacts/github-discoverability.md", import.meta.url);
const schemaOnly = process.argv.includes("--schema-only");

const keywordConfig = JSON.parse(await readFile(keywordsPath, "utf8"));
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const errors = [];
const markets = new Set(["en", "zh"]);
const intents = new Set([
  "architecture",
  "comparison",
  "cost",
  "gateway",
  "image",
  "migration",
  "provider",
  "reliability",
  "video",
]);

if (keywordConfig.schemaVersion !== 1) errors.push("discovery keyword schemaVersion must be 1");
if (!Array.isArray(keywordConfig.queries) || keywordConfig.queries.length === 0) {
  errors.push("queries must be a non-empty array");
}

const seenQueries = new Set();
for (const [index, entry] of (keywordConfig.queries ?? []).entries()) {
  if (typeof entry.query !== "string" || entry.query.trim().length < 3) {
    errors.push(`queries[${index}].query must contain at least three characters`);
  }
  if (!markets.has(entry.market)) errors.push(`queries[${index}].market is invalid`);
  if (!intents.has(entry.intent)) errors.push(`queries[${index}].intent is invalid`);
  const normalized = entry.query?.trim().toLocaleLowerCase("en-US");
  if (seenQueries.has(normalized)) errors.push(`duplicate query: ${entry.query}`);
  seenQueries.add(normalized);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

if (schemaOnly) {
  console.log(`Discovery keyword catalog valid: ${keywordConfig.queries.length} queries`);
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required for the GitHub Search API");

const owner = catalog.owner.toLocaleLowerCase("en-US");
const targetRepositories = new Set(
  catalog.projects.map((project) => `${owner}/${project.repository.toLocaleLowerCase("en-US")}`),
);
const delayMs = Number(process.env.SEARCH_DELAY_MS ?? "1100");

function pause(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function searchRepositories(entry, index) {
  if (index > 0 && delayMs > 0) await pause(delayMs);
  const query = `"${entry.query}" in:name,description,readme,topics fork:false`;
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "luyx-66-discoverability-audit/1.0",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub Search failed for "${entry.query}" with HTTP ${response.status} (remaining: ${remaining ?? "unknown"})`,
    );
  }

  const body = await response.json();
  const items = Array.isArray(body.items) ? body.items : [];
  const matches = items
    .map((item, resultIndex) => ({
      repository: String(item.full_name ?? "").toLocaleLowerCase("en-US"),
      rank: resultIndex + 1,
      stars: Number(item.stargazers_count ?? 0),
      url: item.html_url,
    }))
    .filter((item) => targetRepositories.has(item.repository));

  return {
    ...entry,
    totalResults: Number(body.total_count ?? 0),
    visible: matches.length > 0,
    bestRank: matches[0]?.rank ?? null,
    matches,
  };
}

const results = [];
for (const [index, entry] of keywordConfig.queries.entries()) {
  results.push(await searchRepositories(entry, index));
}

const visible = results.filter((result) => result.visible);
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  owner: catalog.owner,
  queryCount: results.length,
  visibleQueryCount: visible.length,
  visibilityRate: Number((visible.length / results.length).toFixed(4)),
  note: "GitHub Search results are snapshots and may vary by indexing, locale, and ranking changes.",
  results,
};

const summary = [
  "# GitHub discoverability snapshot",
  "",
  `Checked ${report.queryCount} target queries; an ecosystem repository appeared in the first 100 results for ${report.visibleQueryCount}.`,
  "",
  "> Absence is a content and indexing signal, not a workflow failure. Rankings are observational and are never manipulated by this automation.",
  "",
  "| Query | Market | Intent | Ecosystem result | Best rank | Total results |",
  "|---|---:|---|---|---:|---:|",
  ...results.map(
    (result) =>
      `| ${escapeTable(result.query)} | ${result.market} | ${result.intent} | ${
        result.visible ? result.matches.map((match) => match.repository).join(", ") : "not found"
      } | ${result.bestRank ?? "—"} | ${result.totalResults} |`,
  ),
  "",
].join("\n");

await mkdir(outputDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(summaryPath, summary, "utf8");
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
}

console.log(
  `GitHub discoverability checked: ${report.visibleQueryCount}/${report.queryCount} queries currently show an ecosystem repository.`,
);
