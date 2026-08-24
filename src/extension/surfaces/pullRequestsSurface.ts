import { executeSurfaceCommand } from "./surfaceUtilities.js";
import type { GitoSurfaceServices } from "./surfaceTypes.js";

/** PR navigation deliberately reuses Repository Home's cloud/provider lane. */
export class PullRequestsSurface {
  public constructor(private readonly services: GitoSurfaceServices) {}

  public async open(): Promise<void> {
    if (this.services.openHome !== undefined) {
      await this.services.openHome("pullRequests");
      return;
    }
    await executeSurfaceCommand(this.services, "gito.openHome", "pullRequests");
  }
}
