"use client";
import { useEffect, useRef } from "react";
import { TransportError, useLive } from "airtty/client";
import { reply } from "../actions/chat";
import { chats, type Assistant } from "./conversations";

// A long reply can outgrow the default live limit (1000 events), which drops its start.
const EVENT_LIMIT = 100_000;

function describe(error: unknown) {
  if (error instanceof TransportError)
    return error.outcome === "not-sent"
      ? "Server unreachable, nothing was sent"
      : `Stream interrupted (${error.outcome})`;
  return "Stream interrupted";
}

/**
 * Headless: pumps one reply's stream into the store while it is mounted. The chat mounts
 * one per streaming reply, whatever conversation is on screen; stopping a reply unmounts
 * it, which closes the Server generator and the OpenRouter request behind it.
 */
export function ReplyStream({
  conversationId,
  message,
}: {
  conversationId: number;
  message: Assistant;
}) {
  const { items, done, error } = useLive(reply, [message.request], { limit: EVENT_LIMIT });
  const seen = useRef(0);
  useEffect(() => {
    for (const event of items.slice(seen.current)) chats.apply(conversationId, message.id, event);
    seen.current = items.length;
  }, [items, conversationId, message.id]);
  useEffect(() => {
    if (done) chats.finish(conversationId, message.id, error ? describe(error) : undefined);
  }, [done, error, conversationId, message.id]);
  // Unmounted for any other reason (the page itself remounts): the stream is gone, so the
  // reply stops rather than being requested, and billed, a second time.
  useEffect(() => () => chats.stop(conversationId, message.id), [conversationId, message.id]);
  return null;
}
