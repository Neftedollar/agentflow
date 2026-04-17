import type { Command } from "commander";

/** Default SQLite DB path for learning store. */
const DEFAULT_DB_PATH = "./ageflow-learning.db";

export function registerFeedbackCommand(program: Command): void {
  program
    .command("feedback <traceId>")
    .description("Add delayed feedback to a workflow trace")
    .requiredOption(
      "--rating <rating>",
      "Feedback rating: positive | negative | mixed",
    )
    .option("--comment <text>", "Optional comment")
    .option(
      "--source <source>",
      "Feedback source: human | ci | monitoring",
      "human",
    )
    .action(
      async (
        traceId: string,
        opts: { rating: string; comment?: string; source: string },
      ) => {
        try {
          // Validate rating
          const validRatings = ["positive", "negative", "mixed"] as const;
          if (
            !validRatings.includes(opts.rating as (typeof validRatings)[number])
          ) {
            throw new Error(
              `Invalid rating "${opts.rating}". Must be one of: ${validRatings.join(", ")}`,
            );
          }

          // Validate source
          const validSources = ["human", "ci", "monitoring"] as const;
          if (
            !validSources.includes(opts.source as (typeof validSources)[number])
          ) {
            throw new Error(
              `Invalid source "${opts.source}". Must be one of: ${validSources.join(", ")}`,
            );
          }

          const [{ SqliteLearningStore }, { FeedbackSchema }] =
            await Promise.all([
              import("@ageflow/learning-sqlite").catch(() => {
                throw new Error("@ageflow/learning-sqlite not found.");
              }),
              import("@ageflow/learning"),
            ]);

          const feedback = FeedbackSchema.parse({
            rating: opts.rating,
            comment: opts.comment,
            source: opts.source,
            timestamp: new Date().toISOString(),
          });

          const store = new SqliteLearningStore(DEFAULT_DB_PATH);
          const trace = await store.getTrace(traceId);
          if (!trace) {
            throw new Error(`Trace not found: ${traceId}`);
          }

          await store.addFeedback(traceId, feedback);

          process.stdout.write(
            `Feedback recorded for trace ${traceId}: ${opts.rating} (source: ${opts.source})\n`,
          );
        } catch (err) {
          process.stderr.write(
            `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      },
    );
}
