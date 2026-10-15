/** The project folder whose `.tau/settings.json` overrides the user’s settings. The CLI resolves it from the launch directory. */

import { Context } from "effect";

export class ProjectDirectory extends Context.Service<
  ProjectDirectory,
  { readonly directory: string }
>()("tau/host/ProjectDirectory") {}
