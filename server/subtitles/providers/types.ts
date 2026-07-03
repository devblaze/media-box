/** A subtitle provider abstraction so media-box can search several sources. */

export interface ProviderSearchQuery {
  /** ISO 639-1 wanted language, e.g. "en", "el". */
  language: string;
  title?: string | null;
  year?: number | null;
  imdbId?: string | null; // "tt1234567" or "1234567"
  tmdbId?: number | null;
  /** Episode coordinates + parent series ids (unset for movies). */
  season?: number;
  episode?: number;
  parentImdbId?: string | null;
  parentTmdbId?: number | null;
  /** false = exclude hearing-impaired; undefined = no preference. */
  hearingImpaired?: boolean;
}

export interface ProviderCandidate {
  providerId: string;
  language: string;
  /** Release/label shown for context. */
  release: string;
  hearingImpaired: boolean;
  /** Higher = better; used to pick the best within a provider's results. */
  score: number;
  /** Fetch the subtitle text (already decoded to a string, SRT/VTT/ASS). */
  download: () => Promise<string>;
}

export interface ProviderMeta {
  id: string;
  name: string;
  /** One-line description for the settings UI. */
  description: string;
  /** True when the provider needs credentials/config to work. */
  needsConfig: boolean;
  /** ISO 639-1 codes this provider specializes in ([] = general/multi-language). */
  specializes?: string[];
}

export interface SubtitleProvider extends ProviderMeta {
  /** Enabled AND configured enough to be used. */
  isReady(): boolean;
  /** Return candidates ranked best-first (may be empty; must not throw fatally). */
  search(q: ProviderSearchQuery): Promise<ProviderCandidate[]>;
}
