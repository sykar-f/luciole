"use client";
import { useRef, useState } from "react";
import { KeyHelp, useApplication, useBindings, useNavigate } from "@luciole-sh/core/client";
import { login } from "../actions/session";
import { Line } from "./frames";
import { drafts } from "./draft";
import { operationStore } from "./operations";
import { sessionStore } from "./session";
import { color } from "./theme";

type Field = "user" | "pin";

const ACCOUNT_WIDTH = 6;
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
      // Same Application instance: the framework drops cached private trees with the
      // bearer; the previous identity's Drafts and operations are dropped here.
      drafts.clear();
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
  // Bindings run before the focused field: Tab and Enter never reach its value.
  useBindings(
    () => ({
      bindings: [
        {
          key: "tab",
          cmd: () => setField((f) => (f === "user" ? "pin" : "user")),
          desc: "switch field",
          group: "login",
        },
        {
          key: "return",
          cmd: () => (field === "user" ? setField("pin") : void submit()),
          desc: "sign in",
          group: "login",
        },
      ],
    }),
    [field, pending],
  );

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
            <span fg={color.text}>{a.id.padEnd(ACCOUNT_WIDTH)}</span> ({a.role})
          </Line>
        ))}
      </box>
      <box id="login-help" height={1}>
        <KeyHelp inline groups={["login", "luciole"]} fg={color.faint} accent={color.muted} />
      </box>
    </box>
  );
}
