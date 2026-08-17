/**
 * The CLI's only channel to the outside world.
 *
 * Every command writes through {@link RunIo} rather than touching `process`
 * directly, which is what lets `main.test.ts` and `src/cli/*.test.ts` assert on
 * exact output instead of capturing a stream. It lives here rather than in
 * `main.ts` so the command modules can depend on it without importing the
 * composition root that dispatches to them.
 */
import { stderr, stdout } from 'node:process';

export interface RunIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Writes to the real streams, one line at a time. */
export const defaultIo: RunIo = {
  out: (line) => void stdout.write(`${line}\n`),
  err: (line) => void stderr.write(`${line}\n`),
};

/**
 * Reads the whole of standard input as UTF-8.
 *
 * The only way a secret value reaches this process (DESIGN §3.5: "never a
 * command line, visible in Task Manager, never a temp file"), so it is a named
 * seam rather than an inline `for await` — tests substitute it, and there is
 * exactly one place that has to be right about encoding and about not logging
 * what it read.
 */
export type StdinReader = () => Promise<string>;

export const defaultStdin: StdinReader = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
};
