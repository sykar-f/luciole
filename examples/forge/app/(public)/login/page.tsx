import { LoginForm } from "../../../components/LoginForm";
import { USERS } from "../../../server/seed";

export const auth = "public" as const;

export default function LoginPage() {
  return (
    <box flexDirection="column" gap={1} flexGrow={1} alignItems="center" paddingTop={1}>
      <ascii-font text="FORGE" font="block" color="#67d9bc" />
      <text fg="#8b98a5">Code review in the terminal · React Server Components over Flight</text>
      <LoginForm accounts={USERS.map(({ id, role }) => ({ id, role }))} />
    </box>
  );
}
