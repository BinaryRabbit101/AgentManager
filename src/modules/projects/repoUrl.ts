/**
 * Repository-URL parsing for the clone flow (projects DESIGN §2.2, IMPLEMENTATION M3).
 *
 * > "`POST /api/projects/inspect { repoUrl }` — parses the URL (https or ssh),
 * > derives the name and slug, proposes `targetPath = <projectsRoot>/<name>`."
 *
 * Three spellings have to be understood, because they are the three git itself
 * accepts and the user pastes whichever their host showed them:
 *
 * 1. `https://github.com/owner/repo.git` — a URL;
 * 2. `ssh://git@github.com/owner/repo.git` — also a URL;
 * 3. `git@github.com:owner/repo.git` — **not** a URL. The scp-like syntax has no
 *    scheme, and `new URL` reads it as the `git` scheme with an opaque path, so
 *    it is matched before anything is handed to the URL parser.
 *
 * The parser is deliberately shallow: it answers "what is this repository
 * called" and nothing else. Whether the URL is reachable, whether credentials
 * exist for it and whether the branch is right are all questions only `git`
 * can answer, and §2.2 has it answer them — "auth failures surface the git
 * stderr verbatim". Guessing here would only produce a second, wronger opinion.
 *
 * A Windows path (`C:\Code\App`) is refused rather than silently cloned from:
 * the local-folder flow (§2.1) is what registers a directory, and a `repoUrl`
 * that is a path is a user who picked the wrong dialog.
 */
import { InvalidRepoUrlError } from './errors.js';

/** The transports the clone flow understands. `file` exists for local mirrors. */
export type RepoUrlScheme = 'https' | 'http' | 'ssh' | 'git' | 'file';

const SCHEMES: Readonly<Record<string, RepoUrlScheme>> = {
  'https:': 'https',
  'http:': 'http',
  'ssh:': 'ssh',
  'git:': 'git',
  'file:': 'file',
};

export interface ParsedRepoUrl {
  /** The URL as it will be handed to `git clone` — trimmed, otherwise verbatim. */
  readonly url: string;
  readonly scheme: RepoUrlScheme;
  /** `github.com`, or `null` for a `file:` URL, which names no host. */
  readonly host: string | null;
  /** The repository name: the last path segment, without its `.git` suffix. */
  readonly name: string;
}

/**
 * `user@host:path/to/repo.git` — git's scp-like remote syntax.
 *
 * The negative lookahead on `//` keeps `https://…` out (its "host" would be
 * `https` and its path `//github.com/…`), and the two-character minimum on the
 * host keeps `C:\Code` out, because a Windows drive letter is exactly one.
 */
const SCP_LIKE = /^(?:([^@/\\:]+)@)?([^@/\\:]{2,}):(?!\/\/)(.+)$/;

/** The last non-empty segment of a path, `.git` removed. */
function repositoryName(path: string): string | undefined {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  const last = segments.at(-1);
  if (last === undefined) return undefined;
  const trimmed = last.replace(/\.git$/i, '').trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parses a repository URL (§2.2 step 1).
 *
 * @throws InvalidRepoUrlError — with the reason, because "that is not a URL" is
 *   not something a user can act on and "that looks like a local folder path;
 *   use Add existing folder" is.
 */
export function parseRepoUrl(input: unknown): ParsedRepoUrl {
  if (typeof input !== 'string') {
    throw new InvalidRepoUrlError(String(input), `expected a string, got ${typeof input}`);
  }
  const url = input.trim();
  if (url.length === 0) throw new InvalidRepoUrlError(url, 'the URL is empty');

  // A local path is the one wrong answer worth naming specifically: the user
  // wanted the other dialog, and saying so is more use than "unsupported scheme".
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('\\\\')) {
    throw new InvalidRepoUrlError(
      url,
      'that is a local folder path, not a repository URL — register it with "Add existing folder" instead (DESIGN §2.1)',
    );
  }

  const scp = SCP_LIKE.exec(url);
  if (scp !== null && !url.includes('://')) {
    const host = scp[2];
    const path = scp[3];
    if (host === undefined || path === undefined) {
      throw new InvalidRepoUrlError(url, 'the scp-like form needs both a host and a path');
    }
    const name = repositoryName(path);
    if (name === undefined) throw new InvalidRepoUrlError(url, 'the URL names no repository');
    return { url, scheme: 'ssh', host, name };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRepoUrlError(
      url,
      "it is neither a URL (https://…, ssh://…) nor git's scp-like form (git@host:owner/repo.git)",
    );
  }

  const scheme = SCHEMES[parsed.protocol];
  if (scheme === undefined) {
    throw new InvalidRepoUrlError(
      url,
      `"${parsed.protocol.replace(/:$/, '')}" is not a transport AgentManager clones over; use https, ssh, git or file`,
    );
  }

  const name = repositoryName(decodeURIComponent(parsed.pathname));
  if (name === undefined) throw new InvalidRepoUrlError(url, 'the URL names no repository');

  return {
    url,
    scheme,
    // A `file:` URL has an empty host and no business pretending otherwise.
    host: parsed.hostname.length === 0 ? null : parsed.hostname,
    name,
  };
}
