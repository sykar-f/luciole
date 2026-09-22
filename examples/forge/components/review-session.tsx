"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

// Local review progress of one pull request, owned by its persistent layout: the viewed
// files, the selected file and each file's line cursor survive tab switches and
// refreshes, and reset only when another pull request is opened.
type Session = {
  viewed: ReadonlySet<string>;
  toggleViewed: (path: string) => void;
  file: string | null;
  setFile: (path: string) => void;
  cursor: (path: string) => number;
  setCursor: (path: string, row: number) => void;
  split: boolean | null;
  setSplit: (split: boolean) => void;
};
const ReviewSession = createContext<Session | null>(null);

export function ReviewSessionProvider({ children }: { children: ReactNode }) {
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [file, setFile] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [split, setSplit] = useState<boolean | null>(null);
  const value: Session = {
    viewed,
    toggleViewed: (path) =>
      setViewed((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    file,
    setFile,
    cursor: (path) => cursors[path] ?? 0,
    setCursor: (path, row) => setCursors((c) => ({ ...c, [path]: row })),
    split,
    setSplit,
  };
  return <ReviewSession.Provider value={value}>{children}</ReviewSession.Provider>;
}
export function useReviewSession() {
  const session = useContext(ReviewSession);
  if (!session) throw new Error("Pull request layout missing");
  return session;
}
