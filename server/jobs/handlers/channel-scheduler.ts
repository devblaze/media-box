import { CHANNELS, ensureChannelSchedule } from "@/server/channels/schedule";

/**
 * Keep every live-TV channel's schedule materialized ~12h ahead and trigger
 * background grabs for missing next-in-order items. Runs on a short interval so
 * a program is always ready when the current one ends; the read path also
 * self-heals, so channels work even between ticks.
 */
export async function channelSchedulerHandler(): Promise<string> {
  for (const channel of CHANNELS) {
    ensureChannelSchedule(channel, { allowGrab: true });
  }
  return `scheduled ${CHANNELS.length} channels`;
}
