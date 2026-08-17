/**
 * The three avatar kinds (DESIGN §5.2, §14.1).
 *
 * "Avatars are large and emoji-first. A 28px emoji on a coloured disc reads as a
 * face at a glance; initials with the agent's own colour are the fallback. This
 * is where nearly all the personality lives, and it costs nothing."
 *
 * Roster guarantees one of the three kinds is always present, "so there is no
 * missing-image case" — an agent with no `avatar` field still gets initials,
 * derived here from the name so the card never renders a hole.
 *
 * The `file` kind is the only one that touches the network, and it goes through
 * {@link AvatarCache}: fetched with the API client, rendered from an object URL.
 * **There is no `<img src="/api/…">` anywhere in the tree** (§3.1) — over the
 * tailnet that request cannot carry the bearer and would 401.
 *
 * The accessible name is the agent's own name (§15).
 */

import { useEffect, useState, type ReactElement } from 'react';

import { useServices } from '../app/AppContext';
import type { Avatar as AvatarSpec } from '../api/types';

export interface AvatarProps {
  readonly agentId: string;
  readonly name: string;
  readonly avatar: AvatarSpec | undefined;
}

/** Initials from a name, for an agent whose definition declares no avatar. */
export function initialsFor(name: string): string {
  const words = name.split(/\s+/u).filter((word) => word !== '');
  const letters = words
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('');
  const fallback = letters === '' ? name.slice(0, 2) : letters;
  return fallback.toUpperCase().slice(0, 3);
}

export function Avatar({ agentId, name, avatar }: AvatarProps): ReactElement {
  const { avatars } = useServices();
  const isFile = avatar?.kind === 'file';
  const [objectUrl, setObjectUrl] = useState<string | undefined>(() =>
    isFile ? avatars.peek(agentId) : undefined,
  );

  useEffect(() => {
    if (!isFile) return;
    let live = true;
    void avatars.load(agentId).then((url) => {
      if (live) setObjectUrl(url);
    });
    return () => {
      live = false;
    };
  }, [agentId, avatars, isFile]);

  if (avatar?.kind === 'emoji') {
    return (
      <span className="avatar" data-kind="emoji" role="img" aria-label={name}>
        {avatar.value}
      </span>
    );
  }

  if (isFile) {
    return (
      <span className="avatar" data-kind="file" role="img" aria-label={name}>
        {objectUrl === undefined ? null : <img src={objectUrl} alt="" />}
      </span>
    );
  }

  const initials = avatar?.kind === 'initials' ? avatar.value : initialsFor(name);
  const colour = avatar?.kind === 'initials' ? avatar.color : 'var(--specialty-general)';
  return (
    <span
      className="avatar"
      data-kind="initials"
      role="img"
      aria-label={name}
      style={{ background: colour }}
    >
      {initials.toUpperCase()}
    </span>
  );
}
