import type { Act } from '../src/acts.ts';

// The oracle for the made-up examples, written by hand: the one act each message asks for.
export const PRACTICE_ACT: Record<string, Act> = {
  p01: 'purge_cache',
  p02: 'archive_report',
  p03: 'release_hold',
  p04: 'ack_alert',
  p05: 'rotate_key',
  p06: 'post_status',
};
