import { defineArgs } from "luciole/args";
import { z } from "zod";
import { HARNESSES, MODES } from "@luciole/harness/model";

export default defineArgs({
  summary: "One coding-agent session in a terminal, on Claude Code, Codex, pi or opencode",
  options: z
    .object({
      harness: z.enum(HARNESSES).optional().meta({
        short: "H",
        env: "CODER_HARNESS",
        description:
          "Agent harness (default: the first ready of claude, codex, opencode, pi; fake is a scripted demo)",
      }),
      cwd: z.string().optional().meta({
        short: "C",
        env: "CODER_CWD",
        kind: "path",
        placeholder: "DIR",
        description: "Project directory",
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
      mode: z.enum(MODES).default("ask").meta({ description: "Permission mode" }),
      resume: z
        .union([z.literal(true), z.string().min(1)])
        .optional()
        .meta({
          short: "r",
          placeholder: "ID",
          description: "Resume the latest session here, or <ID>",
        }),
    })
    .strict(),
  examples: [
    "coder --harness codex",
    "coder -H claude --mode edits",
    "coder -H pi --resume",
    "coder -H fake",
  ],
});
