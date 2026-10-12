import { definedProperties } from "../../../defined-properties";
import { Launcher } from "../components/Launcher";
import { installedApps, notice, registry } from "../server/context";

export default async function LauncherPage() {
  return (
    <Launcher
      installed={(await installedApps()).map((app) => definedProperties(app))}
      {...(notice === undefined ? {} : { notice })}
      registry={registry.location}
    />
  );
}
