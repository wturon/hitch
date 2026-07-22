import readline from "node:readline/promises";

// Interactive login prompts. Only ever called when stdin is a TTY — the
// non-interactive path (--email/--password flags) never touches these.

export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Like promptLine but with echo suppressed (password entry). */
export function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "") {
          // Ctrl-C: raw mode swallows the signal, so re-raise it ourselves.
          stdin.setRawMode(wasRaw ?? false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}
