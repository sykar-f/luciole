import type { PullDetail } from "./model";

// Title and subtitle of every pull request tab, shared by pages and loading screens.
export const pullTitle = (pull: PullDetail) => `#${pull.number} ${pull.title}`;
export const pullSubtitle = (pull: PullDetail) => {
  const flow =
    pull.state === "merged"
      ? `⇄ merged · @${pull.mergedBy} merged ${pull.headBranch} into ${pull.baseBranch}`
      : pull.state === "open"
        ? `● open · @${pull.author} wants to merge ${pull.headBranch} into ${pull.baseBranch}`
        : `○ closed · ${pull.headBranch}`;
  return `${flow} · revision ${pull.revision} · +${pull.additions} −${pull.deletions}`;
};
