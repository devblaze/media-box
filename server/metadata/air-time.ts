/**
 * Placing an episode's air time.
 *
 * TMDB gives an episode's air *date* only — a bare `YYYY-MM-DD`, with no time of
 * day and no time zone. Storing that as midnight UTC (the old behaviour) makes an
 * episode look "aired" the instant midnight UTC passes, which for shows that
 * broadcast in the evening of a Western time zone is up to ~a day too early — so
 * the wanted/RSS search fires before the episode actually exists and fails.
 *
 * We can't know the exact broadcast minute, but we do know the show's origin
 * country (TMDB `origin_country`). This module turns the bare date into a
 * realistic UTC instant by assuming a prime-time evening broadcast in that
 * country's time zone. It's an approximation (a single representative standard-
 * time offset per country, DST ignored — worst case ±1h), but it moves the
 * "has it aired?" boundary from "midnight UTC" to "≈ when it really airs", which
 * is what the search timing actually needs.
 */

/** Assumed local broadcast hour (24h). Prime-time evening — a safe lower bound
 *  for "the episode is out" that also matches when most releases appear. */
export const DEFAULT_AIR_HOUR_LOCAL = 20;

/**
 * Representative UTC offset (minutes) per ISO-3166-1 country code. Positive is
 * east of UTC. Standard time only — DST is intentionally ignored (the ±1h error
 * is small next to the fact that we're already guessing the air hour). For the
 * US/Canada we use Eastern, which is the reference an "air date" is quoted in.
 */
const COUNTRY_UTC_OFFSET_MINUTES: Record<string, number> = {
  // Americas
  US: -300, CA: -300, MX: -360, BR: -180, AR: -180, CL: -180, CO: -300, PE: -300,
  // UTC / Western Europe
  GB: 0, IE: 0, PT: 0, IS: 0,
  // Central Europe (CET)
  FR: 60, DE: 60, ES: 60, IT: 60, NL: 60, BE: 60, SE: 60, NO: 60, DK: 60,
  PL: 60, CH: 60, AT: 60, CZ: 60, HU: 60,
  // Eastern Europe / Middle East
  GR: 120, FI: 120, RO: 120, BG: 120, UA: 120, ZA: 120, IL: 120, EG: 120,
  TR: 180, RU: 180,
  // Asia
  IN: 330, TH: 420, VN: 420, ID: 420, CN: 480, TW: 480, HK: 480, SG: 480,
  PH: 480, MY: 480, JP: 540, KR: 540,
  // Oceania
  AU: 600, NZ: 720,
};

/** UTC offset (minutes) for a country code, defaulting to 0 (UTC) when unknown. */
export function countryUtcOffsetMinutes(originCountry: string | null | undefined): number {
  if (!originCountry) return 0;
  return COUNTRY_UTC_OFFSET_MINUTES[originCountry.toUpperCase()] ?? 0;
}

/**
 * Convert a TMDB air *date* (`YYYY-MM-DD`) into the UTC instant the episode is
 * assumed to broadcast — prime-time evening in the origin country's time zone.
 * Returns null for a missing/malformed date.
 */
export function airDateToUtc(
  airDate: string | null | undefined,
  originCountry: string | null | undefined
): Date | null {
  if (!airDate) return null;
  const [y, m, d] = airDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const offsetMin = countryUtcOffsetMinutes(originCountry);
  // Instant of DEFAULT_AIR_HOUR_LOCAL local time: local wall time = UTC + offset,
  // so the UTC instant = (that wall time read as UTC) − offset.
  const utcMs = Date.UTC(y, m - 1, d, DEFAULT_AIR_HOUR_LOCAL, 0, 0) - offsetMin * 60_000;
  return new Date(utcMs);
}
