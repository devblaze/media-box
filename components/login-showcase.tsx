"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Purely decorative mock of the media-box browse experience, rendered full-bleed
 * behind the sign-in panel to show off the app before a visitor logs in.
 *
 * It runs pre-authentication, so it never touches the app's API/session. The
 * artwork is a set of real posters/backdrops/title-logos bundled under
 * `public/showcase/` (fetched once from TMDB at build time — see the repo's
 * scripts), served as static local assets so the login page stays self-contained
 * and works offline. Each tile keeps a colour gradient underneath as a graceful
 * fallback if an image ever fails to load, and motion is CSS-only (the `mb-*`
 * classes in globals.css). The whole tree is `aria-hidden` + `pointer-events-none`
 * so it never traps focus or steals clicks from the form.
 */

type Kind = "Movie" | "Series" | "Anime";

type Title = {
  name: string;
  year: number;
  kind: Kind;
  genre: string;
  /** Bundled poster (public/showcase/posters/<slug>.jpg). */
  poster: string;
  /** Fallback gradient stops, shown behind the image / if it fails to load. */
  from: string;
  to: string;
};

/** The fake library — powers both the hero and the scrolling poster rows. */
const LIBRARY: Title[] = [
  { name: "Dune: Part Two", year: 2024, kind: "Movie", genre: "Sci-Fi", poster: "/showcase/posters/dune-part-two.jpg", from: "#b45309", to: "#431407" },
  { name: "The Last of Us", year: 2023, kind: "Series", genre: "Drama", poster: "/showcase/posters/the-last-of-us.jpg", from: "#166534", to: "#052e16" },
  { name: "Edgerunners", year: 2022, kind: "Anime", genre: "Action", poster: "/showcase/posters/edgerunners.jpg", from: "#a21caf", to: "#1e1b4b" },
  { name: "Oppenheimer", year: 2023, kind: "Movie", genre: "Drama", poster: "/showcase/posters/oppenheimer.jpg", from: "#7c2d12", to: "#171717" },
  { name: "Severance", year: 2022, kind: "Series", genre: "Thriller", poster: "/showcase/posters/severance.jpg", from: "#155e75", to: "#0c1122" },
  { name: "Blade Runner 2049", year: 2017, kind: "Movie", genre: "Sci-Fi", poster: "/showcase/posters/blade-runner-2049.jpg", from: "#b91c1c", to: "#431a1a" },
  { name: "Frieren", year: 2023, kind: "Anime", genre: "Adventure", poster: "/showcase/posters/frieren.jpg", from: "#0e7490", to: "#052e2e" },
  { name: "Interstellar", year: 2014, kind: "Movie", genre: "Sci-Fi", poster: "/showcase/posters/interstellar.jpg", from: "#1e3a8a", to: "#020617" },
  { name: "The Bear", year: 2022, kind: "Series", genre: "Drama", poster: "/showcase/posters/the-bear.jpg", from: "#a16207", to: "#1c1917" },
  { name: "Attack on Titan", year: 2013, kind: "Anime", genre: "Action", poster: "/showcase/posters/attack-on-titan.jpg", from: "#7f1d1d", to: "#171717" },
  { name: "Foundation", year: 2021, kind: "Series", genre: "Sci-Fi", poster: "/showcase/posters/foundation.jpg", from: "#4338ca", to: "#0b1020" },
  { name: "Arrival", year: 2016, kind: "Movie", genre: "Sci-Fi", poster: "/showcase/posters/arrival.jpg", from: "#334155", to: "#020617" },
  { name: "Andor", year: 2022, kind: "Series", genre: "Sci-Fi", poster: "/showcase/posters/andor.jpg", from: "#92400e", to: "#0c0a09" },
  { name: "Jujutsu Kaisen", year: 2020, kind: "Anime", genre: "Action", poster: "/showcase/posters/jujutsu-kaisen.jpg", from: "#6d28d9", to: "#1e1b4b" },
  { name: "The Batman", year: 2022, kind: "Movie", genre: "Action", poster: "/showcase/posters/the-batman.jpg", from: "#1f2937", to: "#030712" },
  { name: "Everything Everywhere", year: 2022, kind: "Movie", genre: "Sci-Fi", poster: "/showcase/posters/everything-everywhere.jpg", from: "#db2777", to: "#1e1b4b" },
];

type Hero = Title & {
  slug: string;
  /** Bundled wide backdrop + transparent title logo. */
  backdrop: string;
  logo: string;
  tagline: string;
  accent: string;
  status: string;
  statusClass: string;
};

/** The rotating featured titles at the top of the mock. */
const HERO: Hero[] = [
  {
    ...LIBRARY[0],
    slug: "dune-part-two",
    backdrop: "/showcase/backdrops/dune-part-two.jpg",
    logo: "/showcase/logos/dune-part-two.png",
    tagline: "Long live the fighters.",
    accent: "#f59e0b",
    status: "In your library",
    statusClass: "text-emerald-400",
  },
  {
    ...LIBRARY[1],
    slug: "the-last-of-us",
    backdrop: "/showcase/backdrops/the-last-of-us.jpg",
    logo: "/showcase/logos/the-last-of-us.png",
    tagline: "When you're lost in the darkness, look for the light.",
    accent: "#34d399",
    status: "Available in 4K",
    statusClass: "text-emerald-400",
  },
  {
    ...LIBRARY[2],
    name: "Cyberpunk: Edgerunners",
    slug: "edgerunners",
    backdrop: "/showcase/backdrops/edgerunners.jpg",
    logo: "/showcase/logos/edgerunners.png",
    tagline: "Style over substance? Why not both.",
    accent: "#e879f9",
    status: "Requested",
    statusClass: "text-amber-400",
  },
];

const ROTATE_MS = 6500;

export function LoginShowcase() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Honour reduced-motion: hold on the first featured title instead of rotating.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % HERO.length), ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  const hero = HERO[index];

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none overflow-hidden bg-[#141414]"
    >
      {/* Crossfading hero backdrops (real images over an accent-tinted base). */}
      {HERO.map((h, i) => (
        <div
          key={h.slug}
          className={cn(
            "absolute inset-0 transition-opacity duration-1000 ease-in-out",
            i === index ? "opacity-100" : "opacity-0"
          )}
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `radial-gradient(115% 100% at 78% -5%, ${h.accent}55, transparent 55%), linear-gradient(120deg, ${h.from}, ${h.to})`,
            }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={h.backdrop}
            alt=""
            className="mb-hero-pan absolute inset-0 h-full w-full object-cover object-top"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </div>
      ))}

      {/* Readability scrims — mirror the real HeroBillboard's gradients. */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/20 to-transparent" />

      {/* Foreground: fake nav → hero copy → scrolling rows. */}
      <div className="relative flex h-full flex-col">
        {/* Fake top nav (desktop only) to complete the "app" illusion. */}
        <nav className="hidden items-center gap-7 px-12 pt-7 text-sm text-white/70 lg:flex">
          <span className="mr-2 text-xl font-extrabold uppercase tracking-tight text-red-600">
            media-box
          </span>
          <span className="text-white">Home</span>
          <span>Movies</span>
          <span>Series</span>
          <span>Anime</span>
          <span>Discover</span>
          <span className="ml-auto flex items-center gap-4">
            <span className="grid size-8 place-items-center rounded-full ring-1 ring-white/20">⌕</span>
            <span className="grid size-8 place-items-center rounded bg-gradient-to-br from-red-500 to-red-700 text-xs font-bold text-white">
              M
            </span>
          </span>
        </nav>

        <div className="flex-1" />
        {/* Hero copy, keyed so it re-animates (and resets logo fallback) per rotation. */}
        <HeroCopy key={hero.slug} hero={hero} />

        {/* Scrolling poster rows. */}
        <div className="mt-8 space-y-5 pb-10">
          <PosterRow
            label="Continue Watching"
            items={LIBRARY.slice(0, 8)}
            durationS={46}
            withProgress
          />
          <PosterRow label="Trending Now" items={LIBRARY.slice(6, 16)} durationS={64} reverse />
        </div>
      </div>
    </div>
  );
}

function HeroCopy({ hero }: { hero: Hero }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <div className="mb-fade-up max-w-2xl px-6 md:px-12">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-red-500">
        <span className="grid size-5 place-items-center rounded bg-red-600 text-[10px] text-white">
          ▶
        </span>
        Featured
      </div>

      {logoFailed ? (
        <h2 className="text-4xl font-extrabold tracking-tight text-white drop-shadow-lg md:text-6xl">
          {hero.name}
        </h2>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={hero.logo}
          alt={hero.name}
          className="max-h-28 w-auto max-w-[75%] object-contain drop-shadow-xl md:max-h-36"
          onError={() => setLogoFailed(true)}
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-300">
        <span>{hero.year}</span>
        <span className="text-zinc-600">·</span>
        <span className="uppercase tracking-wide">{hero.kind}</span>
        <span className="text-zinc-600">·</span>
        <span>{hero.genre}</span>
        <span className="text-zinc-600">·</span>
        <span className={hero.statusClass}>{hero.status}</span>
      </div>
      <p className="mt-4 max-w-xl text-sm text-zinc-200 drop-shadow md:text-base">{hero.tagline}</p>
      <div className="mt-6 flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded bg-white px-6 py-2 text-base font-semibold text-black">
          <span>▶</span> Play
        </span>
        <span className="inline-flex items-center gap-2 rounded bg-zinc-500/40 px-6 py-2 text-base font-semibold text-white backdrop-blur-sm">
          <span>ⓘ</span> More Info
        </span>
      </div>
    </div>
  );
}

/** Deterministic resume positions for the "Continue Watching" row (no RNG). */
const PROGRESS = [0.72, 0.34, 0.9, 0.18, 0.55, 0.41, 0.8, 0.27];

function PosterRow({
  label,
  items,
  durationS,
  reverse = false,
  withProgress = false,
}: {
  label: string;
  items: Title[];
  durationS: number;
  reverse?: boolean;
  withProgress?: boolean;
}) {
  // Duplicate the list so the -50% marquee loop is seamless.
  const sequence = [...items, ...items];
  return (
    <div className="space-y-2">
      <h3 className="px-6 text-sm font-semibold text-white/80 md:px-12">{label}</h3>
      <div className="overflow-hidden">
        <div
          className={cn("mb-marquee-track gap-3 pl-6 md:pl-12", reverse && "reverse")}
          style={{ animationDuration: `${durationS}s` }}
        >
          {sequence.map((t, i) => (
            <Poster
              key={`${t.name}-${i}`}
              title={t}
              index={i}
              progress={withProgress ? PROGRESS[i % PROGRESS.length] : null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Poster({
  title,
  index,
  progress,
}: {
  title: Title;
  index: number;
  progress: number | null;
}) {
  const inLibrary = index % 2 === 0;
  return (
    <div
      className="relative aspect-[2/3] w-[124px] shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-white/10 md:w-[144px]"
      style={{ backgroundImage: `linear-gradient(150deg, ${title.from}, ${title.to})` }}
    >
      {/* Fallback title text (revealed only if the poster image fails to load). */}
      <div className="absolute inset-0 flex items-end p-2.5">
        <span className="text-[13px] font-semibold leading-tight text-white/90 drop-shadow">
          {title.name}
        </span>
      </div>

      {/* Real poster art. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={title.poster}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />

      {/* Availability / quality badge. */}
      {inLibrary ? (
        <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-emerald-500 text-[11px] font-bold text-black shadow">
          ✓
        </span>
      ) : (
        <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white backdrop-blur-sm">
          4K
        </span>
      )}

      {/* Resume progress bar for the Continue Watching row. */}
      {progress != null && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/50">
          <div className="h-full bg-red-600" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
