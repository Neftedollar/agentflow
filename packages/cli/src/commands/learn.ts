import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

/** Default SQLite DB path for learning store. */
const DEFAULT_DB_PATH = "./ageflow-learning.db";

/** Load SqliteLearningStore (combined skill + trace store). */
async function loadStore(dbPath = DEFAULT_DB_PATH) {
  const { SqliteLearningStore } = await import(
    "@ageflow/learning-sqlite"
  ).catch(() => {
    throw new Error(
      "@ageflow/learning-sqlite not found. Install @ageflow/learning-sqlite.",
    );
  });
  return new SqliteLearningStore(dbPath);
}

export function registerLearnCommand(program: Command): void {
  const learn = program
    .command("learn")
    .description("Manage learned skills and workflow improvement");

  learn
    .command("status")
    .description("Show active skills with scores and lineage")
    .action(async () => {
      try {
        const store = await loadStore();
        const skills = await store.list();
        const active = skills.filter(
          (s: { status: string }) => s.status === "active",
        );

        if (active.length === 0) {
          process.stdout.write("No active skills found.\n");
          return;
        }

        // Table header
        const header = [
          "ID".padEnd(8),
          "Name".padEnd(32),
          "Agent".padEnd(16),
          "Score".padEnd(8),
          "Runs".padEnd(6),
          "Best",
        ].join(" ");
        process.stdout.write(`${header}\n`);
        process.stdout.write(`${"─".repeat(header.length)}\n`);

        for (const s of active) {
          const row = [
            s.id.slice(0, 8).padEnd(8),
            s.name.slice(0, 32).padEnd(32),
            s.targetAgent.slice(0, 16).padEnd(16),
            s.score.toFixed(3).padEnd(8),
            String(s.runCount).padEnd(6),
            s.bestInLineage ? "yes" : "no",
          ].join(" ");
          process.stdout.write(`${row}\n`);
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  learn
    .command("evaluate")
    .description("Run hypothetical evaluation of draft skills")
    .action(async () => {
      try {
        const [store, { runEvaluation }] = await Promise.all([
          loadStore(),
          import("@ageflow/learning"),
        ]);

        process.stdout.write("Running evaluation workflow...\n");
        const summary = await runEvaluation({
          skillStore: store,
          traceStore: store,
        });

        process.stdout.write(
          `Evaluated ${summary.skillsEvaluated} skill(s).\n`,
        );
        for (const r of summary.results) {
          process.stdout.write(
            `  ${r.skillName} (${r.targetAgent}): delta=${r.meanScoreDelta.toFixed(3)}, improved=${(r.improvedFraction * 100).toFixed(0)}%\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  learn
    .command("promote")
    .description("Run promotion/rollback cycle")
    .action(async () => {
      try {
        const [store, { runPromotion }] = await Promise.all([
          loadStore(),
          import("@ageflow/learning"),
        ]);

        process.stdout.write("Running promotion cycle...\n");
        const summary = await runPromotion({ skillStore: store });

        process.stdout.write(
          `Checked ${summary.skillsChecked} skill(s). Rollbacks: ${summary.rollbacks}. No-ops: ${summary.noops}.\n`,
        );
        for (const action of summary.actions) {
          if (action.type === "rollback") {
            process.stdout.write(
              `  [rollback] ${action.retiredSkillName} → ${action.activatedSkillName}: ${action.reason}\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  learn
    .command("export")
    .description("Dump skills as .skill.md files")
    .option("-o, --out <dir>", "Output directory", "./skills")
    .action(async (opts: { out: string }) => {
      try {
        const store = await loadStore();
        const skills = await store.list();
        const outDir = path.resolve(opts.out);
        fs.mkdirSync(outDir, { recursive: true });

        let count = 0;
        for (const s of skills) {
          const filename = `${s.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.skill.md`;
          const filePath = path.join(outDir, filename);
          const frontmatter = [
            "---",
            `id: ${s.id}`,
            `name: ${s.name}`,
            `description: ${s.description}`,
            `targetAgent: ${s.targetAgent}`,
            ...(s.targetWorkflow
              ? [`targetWorkflow: ${s.targetWorkflow}`]
              : []),
            `version: ${s.version}`,
            `status: ${s.status}`,
            `score: ${s.score}`,
            `runCount: ${s.runCount}`,
            `bestInLineage: ${s.bestInLineage}`,
            "---",
            "",
          ].join("\n");
          fs.writeFileSync(filePath, frontmatter + s.content);
          count++;
        }

        process.stdout.write(`Exported ${count} skill(s) to ${outDir}\n`);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  learn
    .command("import <skillPath>")
    .description("Import .skill.md file into store")
    .action(async (skillPath: string) => {
      try {
        const [store, { SkillRecordSchema }] = await Promise.all([
          loadStore(),
          import("@ageflow/learning"),
        ]);

        const resolvedPath = path.resolve(skillPath);
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`);
        }

        const raw = fs.readFileSync(resolvedPath, "utf-8");

        // Parse YAML-like frontmatter
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch) {
          throw new Error(
            "Invalid .skill.md format: missing frontmatter block",
          );
        }

        const fmLines = (fmMatch[1] ?? "").split("\n");
        const content = fmMatch[2] ?? "";
        const fm: Record<string, unknown> = {};
        for (const line of fmLines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) continue;
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim();
          // Coerce booleans and numbers
          if (val === "true") fm[key] = true;
          else if (val === "false") fm[key] = false;
          else if (/^\d+(\.\d+)?$/.test(val)) fm[key] = Number(val);
          else fm[key] = val;
        }

        const record = SkillRecordSchema.parse({ ...fm, content });
        await store.save(record);

        process.stdout.write(
          `Imported skill "${record.name}" (${record.id})\n`,
        );
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
}
