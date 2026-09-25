// Electrobun 2 builds through Hutch; dependencies stay with Bun and the workspace.
export default {
  electrobun: { version: "2.0.1" },
  packageManager: "bun",
  scripts: {
    dev: ["hutch", "electrobun", "dev"],
    build: ["hutch", "electrobun", "build", "--env=stable"],
  },
};
