import { createContext } from "react";
import type { Application } from "./client";

/** The Application of the mounted Shell, for the hooks and components of the runtime. */
export const Runtime = createContext<Application | null>(null);
