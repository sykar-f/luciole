/**
 * The studio of this Server (one per launch): a harness session writing a project, and
 * what happens after each of its turns (docs/studio/SPEC.md, 2.2 and 5.4). The changes
 * are guarded, built, started in the preview's (confined) Server and committed as a
 * revision; the types are checked beside it, the render reported by the preview itself.
 * A failure goes back to the harness as a `[studio]` message, a bounded number of times.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { serialize } from "airtty/dev";
import { Capabilities } from "airtty/sandbox";
import { HarnessSession } from "@airtty/harness/session";
import type {
  Diagnostic,
  RevisionInfo,
  Stage,
  StageResult,
  StudioSnapshot,
  Validation,
} from "../components/model";
import { config } from "./config";
import { STUDIO_PREFIX } from "./generator";
import { create, pick, START } from "./harness";
import { policy } from "./policy";
import { diagnosticsOf, isolationProblem, PreviewServers, type PreviewTarget } from "./preview";
import { Project } from "./project";
import { prepare } from "./validate";

// Built by the build itself: whatever the harness does to it, the build writes it again.
const GENERATED = "app/routeTree.gen.ts";
const REVISIONS_SHOWN = 50;
// A subscriber gets at most one snapshot per interval.
const UPDATE_INTERVAL_MS = 50;
// What the transcript says of a diagnostic list, at most.
const NOTE_DIAGNOSTICS = 3;

type Cause = "start" | "turn" | "restore" | "capability" | "restart";
type Listener = () => void;

const isolation = isolationProblem(config.preview);

class Studio {
  private project: Project | undefined;
  private servers: PreviewServers | undefined;
  private preview: PreviewTarget | undefined;
  private previewError: string | null = isolation
    ? `The preview cannot be sandboxed here: ${isolation}. Run studio with --preview process to preview the app with your rights.`
    : null;
  private validation: Validation = {
    state: "idle",
    stages: [],
    diagnostics: [],
    fixes: 0,
    maxFixes: config.fixes,
  };
  private problems = new Map<number, "types" | "render">();
  private hosts: string[] = [];
  /** What the harness should hear with the user's next message (a restore, a grant). */
  private pendingNotes: string[] = [];
  /** Diagnostics already sent back, so the same failure is never corrected twice. */
  private lastCorrection = "";
  private readonly listeners = new Set<Listener>();
  private revision = 0;
  private opening: Promise<void> | null = null;
  readonly session: HarnessSession;
  private readonly checks = serialize(() => this.check());
  private cause: Cause = "start";

  constructor() {
    this.session = new HarnessSession({
      harness: config.harness,
      cwd: config.directory,
      // Every file change goes through the policy: inside the app's folders, accepted.
      mode: "ask",
      model: config.model,
      effort: config.effort,
      resume: config.resume,
      create,
      pick,
      start: START,
      policy,
      onTurnCompleted: (status) => {
        if (status !== "interrupted") void this.validate("turn");
      },
    });
  }

  /** Opens the project and shows its last revision; the page's render calls it. */
  open(): Promise<void> {
    this.opening ??= this.boot().catch((error: unknown) => {
      this.previewError = error instanceof Error ? error.message : String(error);
      this.changed();
    });
    return this.opening;
  }

  private async boot() {
    // No sandbox: nothing runs, the harness included, unless --preview process says so.
    if (isolation) throw new Error(this.previewError ?? isolation);
    const project = Project.open(config.directory);
    this.project = project;
    this.hosts = this.declaredHosts();
    this.servers = new PreviewServers(project, config.preview);
    this.servers.granted = Capabilities.parse({ net: this.hosts });
    // The preview's Servers never outlive this one, however it stops.
    const servers = this.servers;
    process.on("exit", () => {
      servers.killAll();
      project.release();
    });
    this.changed();
    void this.session.start();
    await this.validate("start");
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  snapshot(): StudioSnapshot {
    const project = this.project;
    const preview = this.preview;
    return {
      project: {
        name: project?.name ?? config.directory.split("/").at(-1) ?? "",
        directory: config.directory,
      },
      preview: preview
        ? {
            revision: preview.revision,
            url: preview.url,
            output: preview.output,
            fingerprint: preview.fingerprint,
            mode: preview.mode,
            hosts: this.hosts,
            sessions: preview.sessions,
            project: project?.name ?? "",
          }
        : null,
      previewError: this.previewError,
      validation: this.validation,
      revisions: (project?.revisions() ?? []).slice(0, REVISIONS_SHOWN).map((r): RevisionInfo => ({
        number: r.number,
        summary: r.summary,
        at: r.at,
        ...(this.problems.has(r.number) ? { problem: this.problems.get(r.number) } : {}),
      })),
      warning:
        config.preview === "process"
          ? "Preview not isolated: the generated app runs with your rights"
          : null,
    };
  }

  /** The user's message: a new request, so corrections start again from zero. */
  async send(text: string) {
    await this.open();
    this.validation = { ...this.validation, fixes: 0 };
    this.lastCorrection = "";
    const notes = this.pendingNotes.splice(0);
    this.changed();
    return this.session.send(notes.length ? `${text}\n\n${notes.join("\n")}` : text);
  }

  private validate(cause: Cause) {
    this.cause = cause;
    return this.checks.run();
  }

  private stage(stage: Stage, ok: boolean, ms?: number) {
    const stages: StageResult[] = [
      ...this.validation.stages.filter((s) => s.stage !== stage),
      { stage, ok, ...(ms === undefined ? {} : { ms: Math.round(ms) }) },
    ];
    this.validation = { ...this.validation, stages };
    this.changed();
  }

  /** One validation of the working tree: guard, build, Server, then a revision. */
  private async check() {
    const project = this.project;
    const servers = this.servers;
    if (!project || !servers) return;
    const cause = this.cause;
    const changes = project.changes();
    changes.delete(GENERATED);
    const first = cause === "start" || cause === "restart" || cause === "capability";
    if (!changes.size && !first && cause !== "restore") {
      if (cause === "turn") this.session.note("info", "No file changed: nothing to rebuild.");
      return;
    }
    this.validation = {
      ...this.validation,
      state: "validating",
      stages: [],
      diagnostics: [],
      failed: undefined,
    };
    this.changed();
    const prepared = await prepare(project, servers, changes, (stage, ok, ms) =>
      this.stage(stage, ok, ms),
    );
    if (!prepared.ok)
      return this.fail(
        prepared.stage,
        prepared.diagnostics,
        prepared.undone ? "Refused changes were undone" : undefined,
      );
    // A new revision only when something changed; the first build shows the last one.
    const number = changes.size
      ? project.commit(this.summary(cause))
      : (project.revisions()[0]?.number ?? 0);
    let started = performance.now();
    let target: PreviewTarget;
    try {
      target = await servers.start(number, prepared.output);
    } catch (error: unknown) {
      this.stage("server", false, performance.now() - started);
      const message = error instanceof Error ? error.message : String(error);
      this.problems.set(number, "render");
      return this.fail("server", diagnosticsOf(message, project.directory), undefined, number);
    }
    this.stage("server", true, performance.now() - started);
    this.preview = target;
    this.revision = number;
    this.previewError = null;
    this.validation = { ...this.validation, state: "passed", revision: number };
    if (changes.size) this.session.note("info", `Revision r${number} built and running.`);
    this.changed();
    // The types, beside the preview: they do not stop it, they are corrected too.
    started = performance.now();
    const types = await servers.types();
    this.stage("types", !types.length, performance.now() - started);
    if (types.length && this.revision === number) {
      this.problems.set(number, "types");
      this.fail("types", types, undefined, number);
    }
  }

  /** What the revision's commit says: the user's last prompt, or why it was made. */
  private summary(cause: Cause) {
    if (cause === "restore") return "restored";
    const last = this.session
      .snapshot()
      .items.findLast((item) => item.kind === "user" && !item.text.startsWith(STUDIO_PREFIX));
    return last?.kind === "user" ? last.text : "changes";
  }

  /**
   * A stage failed: said in the transcript, then sent back to the harness when a
   * correction is left and this is not the same failure again.
   */
  private fail(stage: Stage, diagnostics: Diagnostic[], note?: string, revision?: number) {
    this.validation = {
      ...this.validation,
      state: "failed",
      failed: stage,
      diagnostics,
      ...(revision === undefined ? {} : { revision }),
    };
    this.changed();
    const lines = diagnostics.map(
      (d) => `- ${d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`,
    );
    this.session.note(
      "error",
      [
        `${stageSentence(stage)}${note ? ` (${note})` : ""}:`,
        ...lines.slice(0, NOTE_DIAGNOSTICS),
      ].join("\n"),
    );
    const fingerprint = `${stage}\n${lines.join("\n")}`;
    const { fixes, maxFixes } = this.validation;
    if (this.cause === "restore" || this.cause === "capability") return;
    if (fixes >= maxFixes || fingerprint === this.lastCorrection) {
      this.session.note(
        "warn",
        fixes >= maxFixes
          ? `No automatic correction left (${maxFixes}): tell the harness what to do, or undo with Ctrl+O u.`
          : "The same failure again: over to you.",
      );
      return;
    }
    // A turn still running (the harness answering another message) gets it afterwards.
    if (this.session.snapshot().state !== "idle") return;
    this.lastCorrection = fingerprint;
    this.validation = { ...this.validation, fixes: fixes + 1 };
    this.changed();
    void this.session.send(
      `${STUDIO_PREFIX} ${stageSentence(stage)}. Fix it, changing only what is needed:\n${lines.join("\n")}`,
    );
  }

  /** The preview's Client reported a failed page (G6, airtty/sandbox `onFailure`). */
  reportFailure(revision: number, path: string, message: string) {
    if (revision !== this.revision || this.validation.state === "validating") return;
    this.problems.set(revision, "render");
    this.stage("render", false);
    this.fail("render", [{ message: `${path}: ${message}` }], undefined, revision);
  }

  /** Puts the project back as revision `number` was, as a new revision. */
  async restore(number: number) {
    const project = this.project;
    if (!project) throw new Error("No project open");
    if (this.session.snapshot().state === "running") await this.session.interrupt();
    project.restore(number);
    this.pendingNotes.push(
      `${STUDIO_PREFIX} Note: the user restored revision r${number}; the files are back to that state.`,
    );
    await this.validate("restore");
  }

  /** Restarts the preview's Server on the same revision (its memory is lost, data/ stays). */
  restart() {
    return this.validate("restart");
  }

  /** The hosts the app declares in its package.json, which only studio writes. */
  private declaredHosts(): string[] {
    const project = this.project;
    if (!project) return [];
    const parsed: unknown = JSON.parse(
      readFileSync(join(project.directory, "package.json"), "utf8"),
    );
    const declared = PackageCapabilities.safeParse(parsed);
    return declared.success ? declared.data.airtty.capabilities.net : [];
  }

  /** The user allows (or no longer allows) the app to reach `host`: a new revision. */
  async setHost(host: string, allowed: boolean) {
    const project = this.project;
    const servers = this.servers;
    if (!project || !servers) throw new Error("No project open");
    const hosts = allowed
      ? [...new Set([...this.hosts, host])]
      : this.hosts.filter((h) => h !== host);
    const file = join(project.directory, "package.json");
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const manifest = PackageJson.parse(parsed);
    manifest.airtty = {
      ...manifest.airtty,
      capabilities: { ...manifest.airtty?.capabilities, net: hosts },
    };
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    // studio's own change, committed as it is: the guard is for the harness's.
    project.commit(`network: ${hosts.join(", ") || "none"}`);
    this.hosts = hosts;
    servers.granted = Capabilities.parse({ net: hosts });
    this.pendingNotes.push(
      `${STUDIO_PREFIX} Note: the user ${allowed ? "allowed" : "no longer allows"} the network host ${host}.`,
    );
    await this.validate("capability");
  }

  patch(number: number) {
    const project = this.project;
    if (!project) throw new Error("No project open");
    return project.patch(number);
  }

  /**
   * The studio's state for one subscriber: a snapshot at once, then one per change, at
   * most once per interval. Hand-written, as the harness session's feed: when the Client
   * leaves, Flight calls `return()` while this waits for a change that may never come.
   */
  subscribe(): AsyncIterableIterator<StudioSnapshot> {
    let dirty = true;
    let closed = false;
    let last = 0;
    let wake: (() => void) | null = null;
    const listener = () => {
      dirty = true;
      wake?.();
    };
    this.listeners.add(listener);
    const close = (): IteratorResult<StudioSnapshot> => {
      closed = true;
      this.listeners.delete(listener);
      wake?.();
      return { done: true, value: undefined };
    };
    const iterator: AsyncIterableIterator<StudioSnapshot> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        while (!closed && !dirty)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const wait = last + UPDATE_INTERVAL_MS - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        if (closed) return { done: true, value: undefined };
        dirty = false;
        last = Date.now();
        return { done: false, value: this.snapshot() };
      },
      return: async () => close(),
      throw: async () => close(),
    };
    return iterator;
  }
}

const PackageCapabilities = z.object({
  airtty: z.object({ capabilities: z.object({ net: z.array(z.string()).default([]) }) }),
});
const PackageJson = z.looseObject({
  airtty: z.looseObject({ capabilities: z.looseObject({}).optional() }).optional(),
});

function stageSentence(stage: Stage) {
  switch (stage) {
    case "guard":
      return "studio refused some changes";
    case "build":
      return "The build failed";
    case "server":
      return "The app's Server did not start";
    case "render":
      return "A page failed in the preview";
    case "types":
      return "The type check failed";
  }
}

export const studio = new Studio();
