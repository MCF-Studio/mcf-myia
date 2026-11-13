import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  tail: string[];
  timedOut: boolean;
}

/**
 * Environnement des programmes lancés par MyIA : celui de MyIA, sans `MYIA_HOME`.
 * L'app installée donne `MYIA_HOME` (son dossier de données) à ce processus. Hérité tel quel, il ferait travailler
 * une autre copie de MyIA lancée par un outil (tests ou `npm run dev` du dépôt, via un build ou Claude Code) sur les
 * données de l'installation au lieu des siennes.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { MYIA_HOME: _home, ...rest } = env;
  return rest;
}

/**
 * Lance un programme SANS shell (argv fixe), lit la sortie ligne par ligne.
 * Garde les `keep` dernières lignes pour le compte rendu. Sans `env`, le programme reçoit `childEnv()`.
 */
export function runProcess(
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    keep?: number;
    onLine?: (line: string, stream: "out" | "err") => void;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.reject(new Error("Commande vide"));
  const keep = opts.keep ?? 60;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      shell: false,
      windowsHide: true,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const tail: string[] = [];
    let timedOut = false;

    const push = (stream: "out" | "err") => {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          tail.push(line);
          if (tail.length > keep) tail.shift();
          opts.onLine?.(line, stream);
        }
      };
    };
    child.stdout!.on("data", push("out"));
    child.stderr!.on("data", push("err"));

    const kill = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer "${cmd}" : ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ code, tail, timedOut });
    });

    if (opts.stdin !== undefined) {
      child.stdin!.end(opts.stdin, "utf8");
    }
  });
}

/** Vrai si la commande se lance (ex. `claude --version`). */
export async function commandWorks(argv: string[], cwd: string): Promise<boolean> {
  try {
    const r = await runProcess(argv, { cwd, timeoutMs: 15_000, keep: 2 });
    return r.code === 0;
  } catch {
    return false;
  }
}
