import { defineArgs } from "luciole/args";
import { z } from "zod";

/**
 * The harnesses studio drives: Claude Code and its scripted generator. Codex, pi and
 * opencode are coder's only: studio cannot keep them from running commands (Codex has no
 * mode without them, docs/studio/SPEC.md).
 */
export const STUDIO_HARNESSES = ["claude", "fake"] as const;
const ONLY_THESE =
  "studio drives claude (Claude Code) or fake (its scripted generator); Codex, pi and opencode run in coder for now, since studio cannot keep them from running commands";
// Automatic corrections after a failed validation, by default and at most.
const DEFAULT_FIXES = 2;
const MAX_FIXES = 5;

export default defineArgs({
  summary: "Describe a luciole app to a coding agent and use it while it is written",
  options: z
    .object({
      // A string checked by zod, not an enum the parser checks first: its refusal of
      // codex would not say why.
      harness: z
        .string()
        .pipe(z.enum(STUDIO_HARNESSES, { error: ONLY_THESE }))
        .optional()
        .meta({
          short: "H",
          env: "STUDIO_HARNESS",
          description: "Agent harness: claude (default) or fake, a scripted generator",
        }),
      dir: z.string().optional().meta({
        short: "d",
        kind: "path",
        placeholder: "DIR",
        description: "Project directory: an empty one gets the template, a studio project reopens",
      }),
      project: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .optional()
        .meta({
          short: "p",
          placeholder: "NAME",
          description: "Project under $XDG_DATA_HOME/luciole/studio (default: a new app-<date>)",
        }),
      resume: z
        .union([z.literal(true), z.string().min(1)])
        .optional()
        .meta({
          short: "r",
          placeholder: "ID",
          description: "Resume the project's last harness session, or <ID>",
        }),
      preview: z.enum(["sandbox", "process"]).default("sandbox").meta({
        description: "How the app runs: sandboxed (default), or with your rights (process)",
      }),
      fixes: z.number().int().min(0).max(MAX_FIXES).default(DEFAULT_FIXES).meta({
        placeholder: "N",
        description: "Automatic corrections after a failed validation",
      }),
      model: z
        .string()
        .min(1)
        .optional()
        .meta({ short: "m", description: "Model, as the harness names it" }),
      effort: z
        .string()
        .min(1)
        .optional()
        .meta({ short: "e", description: "Reasoning effort, if the model has one" }),
    })
    .strict(),
  examples: ["studio -H fake", "studio -H claude --project todos", "studio --dir ~/apps/notes -r"],
});
