import { ConsolePanel } from "../../components/Console";

/** `?callId=` narrows the console to one request, as the Network panel's `o` opens it. */
export default function ConsolePage({ searchParams }: { searchParams: Record<string, string> }) {
  return <ConsolePanel callId={searchParams.callId} />;
}
