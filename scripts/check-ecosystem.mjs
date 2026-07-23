import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const catalogPath = new URL("../ecosystem.json", import.meta.url);
const outputPath = new URL("../artifacts/ecosystem-health.json", import.meta.url);
const schemaOnly = process.argv.includes("--schema-only");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const errors = [];

if (catalog.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!catalog.owner) errors.push("owner is required");
if (!Array.isArray(catalog.projects) || catalog.projects.length === 0) {
  errors.push("projects must be a non-empty array");
}

const repositoryNames = new Set();
for (const [index, project] of (catalog.projects ?? []).entries()) {
  if (!project.repository) errors.push(`projects[${index}].repository is required`);
  if (!project.category) errors.push(`projects[${index}].category is required`);
  if (repositoryNames.has(project.repository)) {
    errors.push(`duplicate repository: ${project.repository}`);
  }
  repositoryNames.add(project.repository);
}

for (const field of ["name", "registrationUrl", "pricingUrl", "documentationUrl"]) {
  if (!catalog.sponsor?.[field]) errors.push(`sponsor.${field} is required`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

if (schemaOnly) {
  console.log(`Catalog valid: ${catalog.projects.length} projects`);
  process.exit(0);
}

const targets = [
  ...catalog.projects.flatMap((project) => [
    {
      kind: "repository",
      name: project.repository,
      url: `https://github.com/${catalog.owner}/${project.repository}`
    },
    ...(project.pagesUrl
      ? [{ kind: "pages", name: project.repository, url: project.pagesUrl }]
      : [])
  ]),
  {
    kind: "sponsor",
    name: "APIMART registration",
    url: catalog.sponsor.registrationUrl
  },
  {
    kind: "sponsor",
    name: "APIMART pricing",
    url: catalog.sponsor.pricingUrl
  },
  {
    kind: "sponsor",
    name: "APIMART documentation",
    url: catalog.sponsor.documentationUrl
  }
];

async function checkTarget(target) {
  const startedAt = Date.now();
  try {
    const response = await fetch(target.url, {
      headers: {
        "user-agent": "luyx-66-ecosystem-health-check/1.0",
        accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000)
    });
    return {
      ...target,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ...target,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

const results = await Promise.all(targets.map(checkTarget));
const report = {
  checkedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((result) => result.ok).length,
  failed: results.filter((result) => !result.ok).length,
  results
};

await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const summary = [
  "# APIMART Labs ecosystem health",
  "",
  `Checked ${report.total} destinations: ${report.passed} passed, ${report.failed} failed.`,
  "",
  "| Type | Destination | Status | Time |",
  "|---|---|---:|---:|",
  ...results.map(
    (result) =>
      `| ${result.kind} | [${result.name}](${result.url}) | ${
        result.ok ? `✅ ${result.status}` : `❌ ${result.status ?? result.error}`
      } | ${result.durationMs} ms |`
  ),
  ""
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
}
console.log(summary);

if (report.failed > 0) process.exitCode = 1;
