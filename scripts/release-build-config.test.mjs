import { describe, expect, it } from "vitest";
import { releaseBuildConfig } from "./release-build-config.mjs";

describe("release build config", () => {
  it("turns on signed updater files", () => {
    expect(releaseBuildConfig("0.2.0")).toEqual({ bundle: { createUpdaterArtifacts: true } });
  });

  it("gives the MSI a numeric version for pre-releases, which WiX requires", () => {
    expect(releaseBuildConfig("0.2.0-rc.1").bundle.windows.wix.version).toBe("0.2.0.1");
    expect(releaseBuildConfig("1.4.2-beta.12").bundle.windows.wix.version).toBe("1.4.2.12");
    expect(releaseBuildConfig("0.2.0-beta").bundle.windows.wix.version).toBe("0.2.0.0");
    expect(releaseBuildConfig("0.2.0-rc.70000").bundle.windows.wix.version).toBe("0.2.0.0");
  });

  it("rejects anything that is not a release version", () => {
    expect(() => releaseBuildConfig("v0.2.0")).toThrow("Not a release version");
  });
});
