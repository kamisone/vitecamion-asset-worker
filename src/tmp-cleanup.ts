import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Removes any `job-*` scratch directories left over from a previous run of
 * this process (e.g. a hard-killed pod that never reached the processor's
 * `finally` cleanup). Container restarts normally get a fresh writable layer
 * in Kubernetes, so this rarely finds anything — it's a cheap defensive
 * sweep for the case of a long-lived pod that crashed and was restarted
 * in-place, or for local dev where /tmp persists across runs.
 */
export async function cleanupStaleTempDirs(): Promise<void> {
  const root = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  const stale = entries.filter(e => e.startsWith('job-'));
  await Promise.all(stale.map(async name => {
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }));
}
