import { lazyRouteComponent } from "@tanstack/react-router";

/** Settings in its own chunk: SettingsShutter draws it, the Settings routes' `loader` preloads it. */
export const Settings = lazyRouteComponent(() => import("./routes/Settings"), "Settings");
