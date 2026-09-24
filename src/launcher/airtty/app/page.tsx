import { Launcher } from "../components/Launcher";
import { installedApps, notice, registry } from "../server/context";

export default async function LauncherPage() {
  return (
    <Launcher installed={await installedApps()} notice={notice} registry={registry.location} />
  );
}
