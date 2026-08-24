import type { DockerExec } from "../../src/sandbox/local-sandbox.ts";

export interface FakeContainer {
  name: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  volume?: string;
}

export interface FakeDocker {
  dockerExec: DockerExec;
  containers: Map<string, FakeContainer>;
  volumes: Set<string>;
  volumeOwners: Map<string, string>;
  networks: Set<string>;
  networkOwners: Map<string, string>;
  networkConnections: Map<string, Set<string>>;
  runCount: number;
  daemonDown: boolean;
  imageMissing: boolean;
  imageId: string;
  imageFingerprint: string;
  commands: string[][];
  inspectFailures: Map<string, string>;
  commandFailures: Map<string, string[]>;
  volumeCreateOwnerOverride?: string;
}

export function installFakeDocker(daemonPort: number): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const volumeOwners = new Map<string, string>();
  const networks = new Set<string>();
  const networkOwners = new Map<string, string>();
  const networkConnections = new Map<string, Set<string>>();
  const self: FakeDocker = {
    containers,
    volumes,
    volumeOwners,
    networks,
    networkOwners,
    networkConnections,
    runCount: 0,
    daemonDown: false,
    imageMissing: false,
    imageId: "sha256:image-v1",
    imageFingerprint: "",
    commands: [],
    inspectFailures: new Map(),
    commandFailures: new Map(),
    dockerExec: async (args) => exec(args),
  };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

  function parseRun(args: string[]): FakeContainer {
    const c: FakeContainer = { name: "", imageId: self.imageId, running: true, labels: {} };
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--name") c.name = args[++i]!;
      else if (a === "--label") {
        const [k = "", v = ""] = args[++i]!.split("=");
        c.labels[k] = v;
      } else if (a === "-v") c.volume = args[++i]!.split(":")[0]!;
      else if (a === "-p" || a === "--cpus" || a === "--memory") i++;
    }
    return c;
  }

  function exec(args: string[]): { code: number; stdout: string; stderr: string } {
    self.commands.push([...args]);
    const [cmd, ...rest] = args;
    if (self.daemonDown) return fail("Cannot connect to the Docker daemon");
    const commandFailures = self.commandFailures.get(args.join("\0"));
    const commandFailure = commandFailures?.shift();
    if (commandFailure) return fail(commandFailure);
    switch (cmd) {
      case "version":
        return ok("Docker version fake");
      case "image": {
        if (self.imageMissing) return fail("Error: No such image");
        return ok(`${self.imageId} ${self.imageFingerprint}`);
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const inspectFailure = self.inspectFailures.get(name);
        if (inspectFailure) {
          self.inspectFailures.delete(name);
          return fail(inspectFailure);
        }
        const c = containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        if (
          rest.includes(
            '{{.State.Running}} {{.Id}} {{range .Mounts}}{{if eq .Destination "/root"}}{{.Name}}{{end}}{{end}}',
          )
        ) {
          return ok(`${c.running} ${c.imageId} ${c.volume ?? ""}`);
        }
        return ok(`${c.running} ${c.imageId} ${c.labels["qm.org"] ?? ""} ${c.labels["qm.sandbox-platform"] ?? ""}`);
      }
      case "network": {
        const sub = rest[0]!;
        let name = rest[rest.length - 1]!;
        if (sub === "connect") name = rest[1]!;
        if (sub === "disconnect") name = rest[2]!;
        if (sub === "inspect") {
          const inspectFailure = self.inspectFailures.get(name);
          if (inspectFailure) {
            self.inspectFailures.delete(name);
            return fail(inspectFailure);
          }
          return networks.has(name)
            ? ok(networkOwners.get(name) ?? "")
            : fail(`Error response from daemon: network ${name} not found`);
        }
        if (sub === "create") {
          if (networks.has(name)) return fail(`network with name ${name} already exists`);
          networks.add(name);
          const label = rest[rest.indexOf("--label") + 1] ?? "";
          networkOwners.set(name, label.startsWith("qm.org=") ? label.slice("qm.org=".length) : "");
          networkConnections.set(name, new Set());
          return ok(name);
        }
        if (sub === "connect") {
          const container = rest[2]!;
          if (!networks.has(name)) return fail(`Error response from daemon: network ${name} not found`);
          const connections = networkConnections.get(name)!;
          if (connections.has(container)) return fail(`endpoint with name ${container} already exists`);
          connections.add(container);
          return ok();
        }
        if (sub === "disconnect") {
          const network = rest[2]!;
          const container = rest[3]!;
          networkConnections.get(network)?.delete(container);
          return ok();
        }
        if (sub === "rm") {
          if ((networkConnections.get(name)?.size ?? 0) > 0) return fail(`network ${name} has active endpoints`);
          networkConnections.delete(name);
          networkOwners.delete(name);
          return networks.delete(name) ? ok(name) : fail(`Error: No such network: ${name}`);
        }
        return fail(`unknown network subcommand ${sub}`);
      }
      case "volume": {
        const sub = rest[0]!;
        const name = rest[rest.length - 1]!;
        if (sub === "inspect") {
          const inspectFailure = self.inspectFailures.get(name);
          if (inspectFailure) {
            self.inspectFailures.delete(name);
            return fail(inspectFailure);
          }
          return volumes.has(name) ? ok(volumeOwners.get(name) ?? "") : fail(`Error: no such volume: ${name}`);
        }
        if (sub === "create") {
          volumes.add(name);
          const label = rest[rest.indexOf("--label") + 1] ?? "";
          volumeOwners.set(
            name,
            self.volumeCreateOwnerOverride ?? (label.startsWith("qm.org=") ? label.slice("qm.org=".length) : ""),
          );
          return ok(name);
        }
        if (sub === "rm") {
          const attached = [...containers.values()].some((c) => c.volume === name);
          if (attached) return fail(`volume is in use`);
          volumeOwners.delete(name);
          return volumes.delete(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        }
        return fail(`unknown volume subcommand ${sub}`);
      }
      case "run": {
        const c = parseRun(rest);
        if (self.imageMissing) return fail("Unable to find image");
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        containers.set(c.name, c);
        self.runCount++;
        return ok("deadbeef");
      }
      case "start": {
        const c = containers.get(rest[0]!);
        if (!c) return fail("Error: No such container");
        c.running = true;
        return ok(rest[0]!);
      }
      case "stop": {
        const c = containers.get(rest[rest.length - 1]!);
        if (!c) return fail("Error: No such container");
        c.running = false;
        return ok();
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        if (!containers.delete(name)) return fail(`Error response from daemon: No such container: ${name}`);
        for (const connections of networkConnections.values()) connections.delete(name);
        return ok(name);
      }
      case "port": {
        const c = containers.get(rest[0]!);
        if (!c || !c.running) return fail("Error: No such container or not running");
        return ok(`127.0.0.1:${daemonPort}`);
      }
      default:
        return fail(`fake docker: unsupported command ${cmd}`);
    }
  }

  return self;
}
