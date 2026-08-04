/**
 * One-off CLI: list the groups this account is in, optionally filtered by name,
 * and print their JIDs for DEFAULT_GROUP_JID.
 *
 *   npm run find-group                # all groups
 *   npm run find-group -- "Team Ops"  # case-insensitive substring match
 *
 * Group *names* are mutable and non-unique, which is why the relay itself only ever
 * addresses groups by JID. Resolving a name at boot (as the original design doc did)
 * silently posts to the wrong group the day someone renames one.
 *
 * IMPORTANT: stop the relay service first. A WhatsApp session has exactly one owner;
 * two clients on the same credentials trigger `connectionReplaced` and can drop the
 * session, forcing a re-link.
 */
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { listGroups } from '../src/wa/groups.js';
import { waClient } from '../src/wa/client.js';

const CONNECT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

async function waitForConnection(): Promise<void> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { state, reason } = waClient.getStatus();
    if (state === 'connected') return;
    if (state === 'needs_relink' || state === 'replaced' || state === 'restricted') {
      throw new Error(`cannot connect: ${state}${reason ? ` (${reason})` : ''}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s waiting for a connection`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const filter = process.argv[2]?.toLowerCase();

  logger.info({ authDir: config.AUTH_DIR }, 'connecting (scan the QR if prompted)');
  await waClient.start();
  await waitForConnection();

  const groups = await listGroups();
  const matched = filter ? groups.filter((g) => g.subject.toLowerCase().includes(filter)) : groups;

  if (matched.length === 0) {
    process.stdout.write(
      filter
        ? `No group name contains "${process.argv[2]}". ${groups.length} group(s) total.\n`
        : 'This account is not in any groups.\n',
    );
  } else {
    process.stdout.write(`\n${matched.length} group(s):\n\n`);
    for (const g of matched) {
      const flags = [
        g.iAmAdmin ? 'admin' : null,
        // Worth surfacing: in an announce-only group a non-admin send is rejected.
        g.announceOnly ? 'announce-only' : null,
        g.isCommunity ? 'community' : null,
      ].filter(Boolean);
      process.stdout.write(`  ${g.subject}\n`);
      process.stdout.write(`    JID          ${g.jid}\n`);
      process.stdout.write(`    participants ${g.participantCount}\n`);
      if (flags.length > 0) process.stdout.write(`    flags        ${flags.join(', ')}\n`);
      process.stdout.write('\n');
    }
    process.stdout.write('Set DEFAULT_GROUP_JID to one of the JIDs above.\n\n');
  }

  await waClient.stop();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, 'find-group failed');
  await waClient.stop().catch(() => {
    /* already failing; nothing useful left to do */
  });
  process.exit(1);
});
