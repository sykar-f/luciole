"use client";
import { useBindings, useNavigate, type NotFoundProps } from "@luciole-sh/core/client";
import { Screen } from "../components/frames";
import { Help } from "../components/Help";
import { color } from "../components/theme";

// The page called notFound(): the directory is gone, is a file, or leaves the root.
export default function Missing({ what }: NotFoundProps) {
  const navigate = useNavigate();
  useBindings(
    () => ({
      bindings: [
        {
          key: "return",
          cmd: () => void navigate({ to: "/", search: {} }),
          desc: "explorer root",
          group: "files",
        },
      ],
    }),
    [navigate],
  );
  return (
    <Screen title={`${what || "Directory"} not found`} help={<Help groups={["files"]} />}>
      <text fg={color.muted}>
        It was removed, is not a directory, or resolves outside the explorer root.
      </text>
    </Screen>
  );
}
