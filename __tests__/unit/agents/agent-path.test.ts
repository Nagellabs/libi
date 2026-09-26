// The PATH libi hands the agents it starts (lib/agents/agent-path.ts): this process's PATH, then every folder of the
// login shell's it lacks, so a launcher the user installed after libi booted can be run by the MCP servers an agent
// starts. The delimiter is passed explicitly, so the cases read the same on any host.
import { describe, it, expect, afterEach } from "vitest";
import {
  __resetAgentSpawnPaths,
  agentChildPath,
  agentSpawnPathDirs,
  forgetAgentSpawnPath,
  recordAgentSpawnPath,
} from "@/lib/agents/agent-path";

afterEach(() => __resetAgentSpawnPaths());

describe("agentChildPath", () => {
  it("keeps this process's PATH first and adds only the login shell's folders it lacks, in the login shell's order", () => {
    expect(agentChildPath({ PATH: "/opt/libi/node/bin:/usr/bin:/bin" }, ["/Users/me/.local/bin", "/usr/bin", "/opt/homebrew/bin"], ":")).toBe(
      "/opt/libi/node/bin:/usr/bin:/bin:/Users/me/.local/bin:/opt/homebrew/bin",
    );
  });

  it("is this process's PATH as it is when the login shell adds nothing, or no login-shell PATH is known", () => {
    expect(agentChildPath({ PATH: "/usr/bin:/bin" }, ["/bin", "/usr/bin"], ":")).toBe("/usr/bin:/bin");
    expect(agentChildPath({ PATH: "/usr/bin:/bin" }, [], ":")).toBe("/usr/bin:/bin");
    expect(agentChildPath({ PATH: "/usr/bin:/bin" }, null, ":")).toBe("/usr/bin:/bin");
    expect(agentChildPath({}, null, ":")).toBeUndefined();
  });

  it("with no PATH of its own, the login shell's folders are the PATH, each once", () => {
    expect(agentChildPath({}, ["/a", "", "/b", "/a"], ":")).toBe("/a:/b");
  });
});

describe("the PATH each running agent process got", () => {
  it("is remembered per agent until its process goes", () => {
    expect(agentSpawnPathDirs("codex")).toBeNull();
    recordAgentSpawnPath("codex", "/usr/bin::/bin", ":");
    expect(agentSpawnPathDirs("codex")).toEqual(["/usr/bin", "/bin"]);
    expect(agentSpawnPathDirs("claude-code")).toBeNull();
    forgetAgentSpawnPath("codex");
    expect(agentSpawnPathDirs("codex")).toBeNull();
  });
});
