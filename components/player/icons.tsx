/**
 * The player's icons: 24×24 line glyphs (filled where noted) that inherit the
 * text colour. Each takes a `className` for size.
 */

type IconProps = { className?: string };

function Line({ className = "size-5", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function Solid({ className = "size-6", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

export const BackIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Line>
);

export const PlayIcon = (p: IconProps) => (
  <Solid {...p}>
    <path d="M8 5v14l11-7-11-7z" />
  </Solid>
);

export const PauseIcon = (p: IconProps) => (
  <Solid {...p}>
    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
  </Solid>
);

export const PrevEpisodeIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M18 6L9 12l9 6V6z" />
    <line x1="6" y1="6" x2="6" y2="18" />
  </Line>
);

export const NextEpisodeIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M6 6l9 6-9 6V6z" />
    <line x1="18" y1="6" x2="18" y2="18" />
  </Line>
);

/** A circular arrow with the step written inside, as most players draw skip buttons. */
export const SkipIcon = ({
  seconds,
  forward,
  className,
}: IconProps & { seconds: number; forward: boolean }) => (
  <Line className={className}>
    {forward ? (
      <>
        <path d="M20 12a8 8 0 1 1-2.34-5.66" />
        <path d="M20 4v4h-4" />
      </>
    ) : (
      <>
        <path d="M4 12a8 8 0 1 0 2.34-5.66" />
        <path d="M4 4v4h4" />
      </>
    )}
    <text
      x="12"
      y="15.5"
      textAnchor="middle"
      fontSize="8.5"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
    >
      {seconds}
    </text>
  </Line>
);

export const VolumeIcon = ({
  muted,
  level,
  className,
}: IconProps & { muted: boolean; level: number }) => (
  <Line className={className}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    {muted || level === 0 ? (
      <path d="m16 9 6 6M22 9l-6 6" />
    ) : (
      <>
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        {level > 0.5 && <path d="M19 5a9 9 0 0 1 0 14" />}
      </>
    )}
  </Line>
);

/** Stacked layers — the file-version picker. */
export const VersionsIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Line>
);

/** Headphones — deliberately not a speaker, so the audio-TRACK picker isn't read
 *  as a second volume control. */
export const AudioTrackIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3z" />
    <path d="M3 19a2 2 0 0 0 2 2h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H3z" />
  </Line>
);

/** Speedometer — the playback-rate picker. */
export const SpeedIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M12 14l4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </Line>
);

/** A small window inside a large one — picture in picture. */
export const PipIcon = (p: IconProps) => (
  <Line {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
  </Line>
);

export const SearchIcon = (p: IconProps) => (
  <Line {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Line>
);

export const SkipToIcon = (p: IconProps) => (
  <Line {...p}>
    <path d="M5 4l10 8-10 8V4z" />
    <path d="M19 5v14" />
  </Line>
);

export const FullscreenIcon = ({ active, className }: IconProps & { active: boolean }) => (
  <Line className={className}>
    {active ? (
      <path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3" />
    ) : (
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
    )}
  </Line>
);
