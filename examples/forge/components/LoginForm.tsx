"use client";
import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useApplication, useNavigate } from "airtty/client";
import { login } from "../actions/session";
import { Line } from "./frames";
import { operationStore } from "./operations";
import { sessionStore } from "./session";
import { color } from "./theme";

type Field = "user" | "pin";

export function LoginForm({ accounts }: { accounts: { id: string; role: string }[] }) {
  const app = useApplication();
  const navigate = useNavigate();
  const [field, setField] = useState<Field>("user");
  const [user, setUser] = useState("");
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  // Keys of one terminal read ("forge⏎") are handled before React re-renders: submit
  // reads the latest typed values, not the ones captured by the last render.
  const typed = useRef({ user: "", pin: "" });

  async function submit() {
    if (pending) return;
    setPending(true);
    setMessage("Signing in…");
    try {
      const result = await login(typed.current.user, typed.current.pin);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      // Same Application instance: the bearer changes and the framework drops the
      // Drafts; app-level stores of the previous identity are dropped here.
      operationStore.clear();
      sessionStore.set(result.identity);
      app.setToken(result.token);
      await navigate({ to: "/" });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }
  useKeyboard((key) => {
    if (key.name !== "tab") return;
    // Global handlers run before the focused field: keep Tab out of the typed value.
    key.preventDefault();
    setField((f) => (f === "user" ? "pin" : "user"));
  });

  return (
    <box flexDirection="column" gap={1} flexShrink={0} width={52}>
      <box flexDirection="column" border borderColor={color.border} padding={1} gap={1}>
        <box flexDirection="row" gap={1} height={1}>
          <Line fg={field === "user" ? color.accent : color.muted}>User </Line>
          <input
            id="login-user"
            focused={field === "user"}
            value={user}
            onInput={(value) => {
              typed.current.user = value;
              setUser(value);
            }}
            onSubmit={() => setField("pin")}
            placeholder="alice, bob or carol"
            flexGrow={1}
          />
        </box>
        <box flexDirection="row" gap={1} height={1}>
          <Line fg={field === "pin" ? color.accent : color.muted}>PIN </Line>
          <input
            id="login-pin"
            focused={field === "pin"}
            value={pin}
            onInput={(value) => {
              typed.current.pin = value;
              setPin(value);
            }}
            onSubmit={() => void submit()}
            placeholder="forge"
            flexGrow={1}
          />
        </box>
      </box>
      <Line id="login-message" fg={color.warn}>
        {message}
      </Line>
      <box flexDirection="column">
        <Line fg={color.muted}>
          Demo accounts · PIN <span fg={color.accent}>forge</span> for everyone
        </Line>
        {accounts.map((a) => (
          <Line key={a.id} fg={color.muted}>
            {"  "}
            <span fg={color.text}>{a.id.padEnd(6)}</span> ({a.role})
          </Line>
        ))}
      </box>
      <Line fg={color.faint}>Tab switch field · Enter sign in · Ctrl+C quit</Line>
    </box>
  );
}
