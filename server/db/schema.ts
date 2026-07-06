import {
  sqliteTable,
  integer,
  text,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// ---------- Library: series ----------

export const series = sqliteTable(
  "series",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tmdbId: integer("tmdb_id").notNull(),
    tvdbId: integer("tvdb_id"),
    imdbId: text("imdb_id"),
    title: text("title").notNull(),
    sortTitle: text("sort_title").notNull(),
    year: integer("year"),
    overview: text("overview"),
    status: text("status", { enum: ["continuing", "ended", "upcoming"] })
      .notNull()
      .default("continuing"),
    network: text("network"),
    runtime: integer("runtime"),
    posterPath: text("poster_path"),
    backdropPath: text("backdrop_path"),
    path: text("path").notNull(),
    rootFolderId: integer("root_folder_id").references(() => rootFolders.id, {
      onDelete: "set null",
    }),
    qualityProfileId: integer("quality_profile_id")
      .notNull()
      .references(() => qualityProfiles.id),
    monitored: integer("monitored", { mode: "boolean" }).notNull().default(true),
    // which episodes to monitor: all, future (unaired/next) only, or none
    monitorMode: text("monitor_mode", { enum: ["all", "future", "none"] })
      .notNull()
      .default("all"),
    // Marks the series as anime (own library path / Anime category).
    isAnime: integer("is_anime", { mode: "boolean" }).notNull().default(false),
    seasonFolder: integer("season_folder", { mode: "boolean" }).notNull().default(true),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
    lastRefreshAt: integer("last_refresh_at", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("series_tmdb_id_unique").on(t.tmdbId)]
);

export const seasons = sqliteTable(
  "seasons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seriesId: integer("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    monitored: integer("monitored", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("seasons_series_season_unique").on(t.seriesId, t.seasonNumber)]
);

export const episodes = sqliteTable(
  "episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seriesId: integer("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    absoluteNumber: integer("absolute_number"),
    tmdbEpisodeId: integer("tmdb_episode_id"),
    title: text("title"),
    overview: text("overview"),
    airDateUtc: integer("air_date_utc", { mode: "timestamp" }),
    runtime: integer("runtime"),
    monitored: integer("monitored", { mode: "boolean" }).notNull().default(true),
    episodeFileId: integer("episode_file_id").references((): AnySQLiteColumn => episodeFiles.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("episodes_series_season_episode_unique").on(
      t.seriesId,
      t.seasonNumber,
      t.episodeNumber
    ),
    index("episodes_air_date_idx").on(t.seriesId, t.airDateUtc),
    index("episodes_missing_idx").on(t.monitored, t.episodeFileId),
  ]
);

export const episodeFiles = sqliteTable("episode_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seriesId: integer("series_id")
    .notNull()
    .references(() => series.id, { onDelete: "cascade" }),
  relativePath: text("relative_path").notNull(),
  size: integer("size").notNull(),
  quality: text("quality", { mode: "json" }).notNull(),
  releaseGroup: text("release_group"),
  sceneName: text("scene_name"),
  dateAdded: integer("date_added", { mode: "timestamp" }).notNull(),
  mediaInfo: text("media_info", { mode: "json" }),
});

// ---------- Library: movies ----------

export const movies = sqliteTable(
  "movies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tmdbId: integer("tmdb_id").notNull(),
    imdbId: text("imdb_id"),
    title: text("title").notNull(),
    sortTitle: text("sort_title").notNull(),
    year: integer("year"),
    overview: text("overview"),
    runtime: integer("runtime"),
    // TMDB collection (franchise) this movie belongs to, if any. Movies sharing a
    // collectionTmdbId form a franchise played in year order on the Movies channel.
    collectionTmdbId: integer("collection_tmdb_id"),
    collectionName: text("collection_name"),
    status: text("status", { enum: ["announced", "inCinemas", "released"] })
      .notNull()
      .default("announced"),
    physicalRelease: integer("physical_release", { mode: "timestamp" }),
    digitalRelease: integer("digital_release", { mode: "timestamp" }),
    posterPath: text("poster_path"),
    backdropPath: text("backdrop_path"),
    path: text("path").notNull(),
    rootFolderId: integer("root_folder_id").references(() => rootFolders.id, {
      onDelete: "set null",
    }),
    qualityProfileId: integer("quality_profile_id")
      .notNull()
      .references(() => qualityProfiles.id),
    monitored: integer("monitored", { mode: "boolean" }).notNull().default(true),
    minimumAvailability: text("minimum_availability", {
      enum: ["announced", "inCinemas", "released"],
    })
      .notNull()
      .default("released"),
    movieFileId: integer("movie_file_id").references((): AnySQLiteColumn => movieFiles.id, {
      onDelete: "set null",
    }),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
    lastRefreshAt: integer("last_refresh_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("movies_tmdb_id_unique").on(t.tmdbId),
    index("movies_missing_idx").on(t.monitored, t.movieFileId),
    index("movies_collection_idx").on(t.collectionTmdbId),
  ]
);

export const movieFiles = sqliteTable("movie_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  movieId: integer("movie_id")
    .notNull()
    .references(() => movies.id, { onDelete: "cascade" }),
  relativePath: text("relative_path").notNull(),
  size: integer("size").notNull(),
  quality: text("quality", { mode: "json" }).notNull(),
  releaseGroup: text("release_group"),
  sceneName: text("scene_name"),
  dateAdded: integer("date_added", { mode: "timestamp" }).notNull(),
  mediaInfo: text("media_info", { mode: "json" }),
});

// ---------- Subtitles (Bazarr-style sidecar files) ----------

export const subtitleFiles = sqliteTable(
  "subtitle_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Exactly one of movieId / episodeId is set.
    movieId: integer("movie_id").references(() => movies.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    language: text("language").notNull(), // ISO 639-1, e.g. "en"
    // Sidecar path relative to the movie.path / series.path root (e.g. "Movie (2020).en.srt").
    relativePath: text("relative_path").notNull(),
    provider: text("provider").notNull(),
    hearingImpaired: integer("hearing_impaired", { mode: "boolean" }).notNull().default(false),
    addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("subtitle_movie_idx").on(t.movieId, t.language),
    index("subtitle_episode_idx").on(t.episodeId, t.language),
  ]
);

// ---------- Configuration ----------

export const qualityProfiles = sqliteTable("quality_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  upgradeAllowed: integer("upgrade_allowed", { mode: "boolean" }).notNull().default(true),
  cutoffQualityId: integer("cutoff_quality_id").notNull(),
  // ordered worst -> best: [{ qualityId: number, allowed: boolean }]
  items: text("items", { mode: "json" }).notNull(),
  // Release preferences matched against the release title (case-insensitive
  // substring, or /regex/). Preferred terms add their score; a release with a
  // required term is mandatory (if any set); an ignored term rejects the release.
  preferredTerms: text("preferred_terms", { mode: "json" })
    .$type<{ term: string; score: number }[]>()
    .notNull()
    .default([]),
  requiredTerms: text("required_terms", { mode: "json" }).$type<string[]>().notNull().default([]),
  ignoredTerms: text("ignored_terms", { mode: "json" }).$type<string[]>().notNull().default([]),
});

export const rootFolders = sqliteTable(
  "root_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").notNull(),
    mediaType: text("media_type", { enum: ["series", "movies", "anime"] }).notNull(),
  },
  (t) => [uniqueIndex("root_folders_path_unique").on(t.path)]
);

export const remotePathMappings = sqliteTable("remote_path_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  downloadClientId: integer("download_client_id")
    .notNull()
    .references(() => downloadClients.id, { onDelete: "cascade" }),
  remotePath: text("remote_path").notNull(),
  localPath: text("local_path").notNull(),
});

export const namingConfig = sqliteTable("naming_config", {
  id: integer("id").primaryKey(),
  renameEpisodes: integer("rename_episodes", { mode: "boolean" }).notNull().default(true),
  replaceIllegalCharacters: integer("replace_illegal_characters", { mode: "boolean" })
    .notNull()
    .default(true),
  standardEpisodeFormat: text("standard_episode_format")
    .notNull()
    .default("{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality}]"),
  seriesFolderFormat: text("series_folder_format").notNull().default("{Series Title} ({Year})"),
  seasonFolderFormat: text("season_folder_format").notNull().default("Season {season:00}"),
  movieFormat: text("movie_format").notNull().default("{Movie Title} ({Year}) [{Quality}]"),
  movieFolderFormat: text("movie_folder_format").notNull().default("{Movie Title} ({Year})"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});

export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label").notNull(),
  },
  (t) => [uniqueIndex("tags_label_unique").on(t.label)]
);

export const seriesTags = sqliteTable(
  "series_tags",
  {
    seriesId: integer("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("series_tags_unique").on(t.seriesId, t.tagId)]
);

export const movieTags = sqliteTable(
  "movie_tags",
  {
    movieId: integer("movie_id")
      .notNull()
      .references(() => movies.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("movie_tags_unique").on(t.movieId, t.tagId)]
);

// ---------- Acquisition ----------

export const indexers = sqliteTable("indexers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  apiKey: text("api_key"),
  categories: text("categories", { mode: "json" })
    .notNull()
    .default([5000, 5030, 5040, 2000, 2010, 2020, 2030, 2040, 2045, 2060]),
  enableRss: integer("enable_rss", { mode: "boolean" }).notNull().default(true),
  enableAutomaticSearch: integer("enable_automatic_search", { mode: "boolean" })
    .notNull()
    .default(true),
  enableInteractiveSearch: integer("enable_interactive_search", { mode: "boolean" })
    .notNull()
    .default(true),
  supportsTv: integer("supports_tv", { mode: "boolean" }).notNull().default(true),
  supportsMovies: integer("supports_movies", { mode: "boolean" }).notNull().default(true),
  minimumSeeders: integer("minimum_seeders").notNull().default(1),
  priority: integer("priority").notNull().default(25),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const downloadClients = sqliteTable("download_clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["qbittorrent", "torbox"] }).notNull(),
  // qbittorrent: { host, port, useSsl, username, password, category }
  // torbox: { apiKey, stagingDir }
  settings: text("settings", { mode: "json" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(1),
  removeCompletedDownloads: integer("remove_completed_downloads", { mode: "boolean" })
    .notNull()
    .default(true),
});

export const downloads = sqliteTable(
  "downloads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    downloadClientId: integer("download_client_id")
      .notNull()
      .references(() => downloadClients.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    mediaType: text("media_type", { enum: ["series", "movie"] }).notNull(),
    seriesId: integer("series_id").references(() => series.id, { onDelete: "set null" }),
    movieId: integer("movie_id").references(() => movies.id, { onDelete: "set null" }),
    episodeIds: text("episode_ids", { mode: "json" }),
    title: text("title").notNull(),
    quality: text("quality", { mode: "json" }),
    indexerId: integer("indexer_id"),
    protocol: text("protocol").notNull().default("torrent"),
    status: text("status", {
      enum: [
        "queued",
        "downloading",
        "remoteCompleted",
        "fetching",
        "importPending",
        "importing",
        "imported",
        "failed",
        "warning",
      ],
    })
      .notNull()
      .default("queued"),
    statusMessage: text("status_message"),
    size: integer("size"),
    sizeLeft: integer("size_left"),
    outputPath: text("output_path"),
    // Manual "grab anyway" override — skips the not-an-upgrade import guard so a
    // deliberately different (even lower) quality can replace/version the file.
    override: integer("override", { mode: "boolean" }).notNull().default(false),
    grabbedAt: integer("grabbed_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("downloads_client_external_unique").on(t.downloadClientId, t.externalId),
    index("downloads_status_idx").on(t.status),
  ]
);

export const history = sqliteTable(
  "history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventType: text("event_type", {
      enum: ["grabbed", "imported", "downloadFailed", "fileDeleted", "fileRenamed", "ignored"],
    }).notNull(),
    mediaType: text("media_type", { enum: ["series", "movie"] }).notNull(),
    seriesId: integer("series_id"),
    episodeId: integer("episode_id"),
    movieId: integer("movie_id"),
    sourceTitle: text("source_title"),
    quality: text("quality", { mode: "json" }),
    indexerId: integer("indexer_id"),
    downloadClientId: integer("download_client_id"),
    downloadExternalId: text("download_external_id"),
    data: text("data", { mode: "json" }),
    date: integer("date", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("history_date_idx").on(t.date)]
);

export const blocklist = sqliteTable("blocklist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mediaType: text("media_type", { enum: ["series", "movie"] }).notNull(),
  seriesId: integer("series_id"),
  movieId: integer("movie_id"),
  sourceTitle: text("source_title").notNull(),
  infoHash: text("info_hash"),
  reason: text("reason"),
  date: integer("date", { mode: "timestamp" }).notNull(),
});

// ---------- Jobs ----------

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    // How to schedule: fixed interval, or a daily / weekly time of day.
    scheduleKind: text("schedule_kind", { enum: ["interval", "daily", "weekly"] })
      .notNull()
      .default("interval"),
    scheduleHour: integer("schedule_hour"), // 0-23 (daily/weekly)
    scheduleMinute: integer("schedule_minute"), // 0-59 (daily/weekly)
    scheduleDay: integer("schedule_day"), // 0-6, Sun=0 (weekly)
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    lastDurationMs: integer("last_duration_ms"),
    lastResult: text("last_result"),
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("scheduled_tasks_name_unique").on(t.name)]
);

export const commands = sqliteTable(
  "commands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    payload: text("payload", { mode: "json" }),
    status: text("status", { enum: ["queued", "started", "completed", "failed"] })
      .notNull()
      .default("queued"),
    priority: integer("priority").notNull().default(0),
    trigger: text("trigger", { enum: ["scheduled", "manual", "system"] })
      .notNull()
      .default("system"),
    queuedAt: integer("queued_at", { mode: "timestamp" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    error: text("error"),
    // The handler's return string (per-run log line), for the task run history.
    result: text("result"),
  },
  (t) => [
    index("commands_status_idx").on(t.status, t.priority),
    // Newest-first listing + pagination on the Tasks page (large after a re-import).
    index("commands_queued_at_idx").on(t.queuedAt),
  ]
);

// ---------- Users & requests ----------

/**
 * Admin-defined roles that grant granular capabilities to non-admin users.
 * `permissions` is a JSON array of permission keys (see `lib/permissions.ts`).
 * The built-in super-admin (`users.role === "admin"`) bypasses all permission
 * checks and is independent of this table — roles only ever *add* capability to
 * ordinary users.
 */
export const roles = sqliteTable(
  "roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    permissions: text("permissions", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("roles_name_unique").on(t.name)]
);

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    // Optional custom role granting extra permissions to a non-admin user. Null =
    // a plain user with no special capabilities. Ignored for admins (super-admin).
    roleId: integer("role_id").references(() => roles.id, { onDelete: "set null" }),
    // Personal Pushover user key for request-available notifications (null = off).
    pushoverUserKey: text("pushover_user_key"),
    // Last authenticated activity (throttled heartbeat), drives online/offline in
    // the admin Users panel. Null until the user makes their first request post-migration.
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("users_username_unique").on(t.username)]
);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mediaType: text("media_type", { enum: ["series", "movie"] }).notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    title: text("title").notNull(),
    year: integer("year"),
    posterPath: text("poster_path"),
    // for series requests: requested season numbers, null = all
    seasons: text("seasons", { mode: "json" }),
    status: text("status", { enum: ["pending", "approved", "declined", "available"] })
      .notNull()
      .default("pending"),
    declineReason: text("decline_reason"),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    seriesId: integer("series_id").references(() => series.id, { onDelete: "set null" }),
    movieId: integer("movie_id").references(() => movies.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("requests_status_idx").on(t.status),
    index("requests_user_idx").on(t.userId),
  ]
);

/**
 * Pending file changes held for approval when `fileOperationsMode` is "ask".
 * Each row captures a deferred file operation (an import, an organize, or a
 * with-files delete): `payload` holds everything needed to re-run it on approval,
 * `title`/`detail` are the human label shown to the approver. Mirrors the
 * `requests` approval workflow (see server/library/file-change-service.ts).
 */
export const fileChanges = sqliteTable(
  "file_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", {
      enum: ["import", "organize", "deleteMovie", "deleteSeries", "deleteVersion"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "approved", "declined", "applied", "failed"],
    })
      .notNull()
      .default("pending"),
    // Human-readable label + optional secondary line (e.g. target path / summary).
    title: text("title").notNull(),
    detail: text("detail"),
    // Everything needed to execute the operation later (JSON), e.g. { downloadId }.
    payload: text("payload", { mode: "json" }).notNull(),
    requestedByUserId: integer("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedByUserId: integer("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("file_changes_status_idx").on(t.status)]
);

// ---------- Playback: per-user watch progress ----------

export const watchProgress = sqliteTable(
  "watch_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Exactly one of movieId / episodeId is set. seriesId is denormalized on episode
    // rows so "continue watching" can find the latest episode per series cheaply.
    movieId: integer("movie_id").references(() => movies.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    seriesId: integer("series_id").references(() => series.id, { onDelete: "cascade" }),
    positionSeconds: integer("position_seconds").notNull().default(0),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    watched: integer("watched", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("watch_user_movie_unique").on(t.userId, t.movieId),
    uniqueIndex("watch_user_episode_unique").on(t.userId, t.episodeId),
    index("watch_user_updated_idx").on(t.userId, t.updatedAt),
  ]
);

// ---------- Diagnostics: app log (admin debug view) ----------

export const logEntries = sqliteTable(
  "log_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    level: text("level", { enum: ["debug", "info", "warn", "error"] }).notNull(),
    source: text("source"),
    message: text("message").notNull(),
    context: text("context", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("log_created_idx").on(t.createdAt)]
);

// ---------- Downloads organizer: log of files organized into the library ----------

export const organizeLog = sqliteTable(
  "organize_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourcePath: text("source_path").notNull(),
    destPath: text("dest_path"),
    mediaType: text("media_type", { enum: ["movie", "series", "anime"] }),
    /** Matched library title (series/movie name). */
    title: text("title"),
    /** e.g. "S01E03" for an episode, or the year for a movie. */
    detail: text("detail"),
    /** hardlink | copy | move | skip */
    action: text("action"),
    status: text("status", { enum: ["organized", "failed", "skipped"] }).notNull(),
    message: text("message"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("organize_log_created_idx").on(t.createdAt)]
);

// ---------- Library-import scan session (persisted so "Import all" runs in the
// background and the unmatched list survives navigation without rescanning) ----------

export const scanCandidates = sqliteTable(
  "scan_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ["movie", "series", "anime"] }).notNull(),
    rootFolderId: integer("root_folder_id"),
    qualityProfileId: integer("quality_profile_id"),
    path: text("path").notNull(),
    videoPath: text("video_path"),
    name: text("name").notNull(),
    parsedTitle: text("parsed_title").notNull(),
    parsedYear: integer("parsed_year"),
    status: text("status", { enum: ["matched", "unsure"] }).notNull(),
    suggestedTmdbId: integer("suggested_tmdb_id"),
    suggestions: text("suggestions", { mode: "json" }),
    // playback of the import: false until it has been imported by "Import all" / manual.
    imported: integer("imported", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  // No unique index: several loose movies can share a category folder (path =
  // dirname), and persistScanCandidates replaces all rows for a type on each scan.
  (t) => [index("scan_candidates_type_idx").on(t.type)]
);

// ---------- Live TV channels: synchronized program schedule ----------
//
// Each channel (movies / series / anime) is a broadcast station whose "now
// playing" is derived from the wall clock: the program whose [startAt, endAt)
// window contains `now`, at offset `now - startAt`. The schedule is materialized
// ahead of time (a rolling ~12h horizon) so it doubles as the TV Guide, and so
// every viewer who tunes in sees the same title at the same moment.

export const channelPrograms = sqliteTable(
  "channel_programs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel", { enum: ["movies", "series", "anime"] }).notNull(),
    mediaType: text("media_type", { enum: ["movie", "episode"] }).notNull(),
    // Exactly one of movieId / episodeId is set (cascade-cleared if the library row goes away).
    movieId: integer("movie_id").references(() => movies.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "cascade" }),
    // Denormalized display label for the guide (e.g. "Supernatural · S01E02 — Wendigo").
    title: text("title").notNull(),
    startAt: integer("start_at", { mode: "timestamp" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp" }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
  },
  (t) => [index("channel_programs_channel_start_idx").on(t.channel, t.startAt)]
);

// Per-show / per-franchise cursor so episodes and sequels advance in order across
// occurrences. refKind "series" -> refId = series.id (lastEpisodeId set); refKind
// "collection" -> refId = movies.collectionTmdbId (lastMovieId set).
export const channelProgress = sqliteTable(
  "channel_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel", { enum: ["movies", "series", "anime"] }).notNull(),
    refKind: text("ref_kind", { enum: ["series", "collection"] }).notNull(),
    refId: integer("ref_id").notNull(),
    lastEpisodeId: integer("last_episode_id"),
    lastMovieId: integer("last_movie_id"),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("channel_progress_ref_unique").on(t.channel, t.refKind, t.refId)]
);
