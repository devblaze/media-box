"use client";

import { createContext, useContext, useEffect, useState } from "react";

interface BrowseState {
  query: string;
  setQuery: (q: string) => void;
  /** When true, browse rows / hero / search show only titles in the library. */
  availableOnly: boolean;
  setAvailableOnly: (v: boolean) => void;
}

/**
 * Shared browse state for the Netflix (non-admin) shell: the search query and the
 * "available only" toggle. The <NetflixHeader/> writes them; the browse pages
 * read them. Lives in the (app) layout's AppShell so it persists across client
 * navigations. Returns `null` under the admin/sidebar shell (no provider).
 */
const SearchContext = createContext<BrowseState | null>(null);

const AVAILABLE_ONLY_KEY = "mediabox.availableOnly";

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState("");
  const [availableOnly, setAvailableOnlyState] = useState(false);

  // Hydrate the toggle from localStorage on the client (SSR renders the default).
  useEffect(() => {
    try {
      if (localStorage.getItem(AVAILABLE_ONLY_KEY) === "1") setAvailableOnlyState(true);
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, []);

  function setAvailableOnly(v: boolean) {
    setAvailableOnlyState(v);
    try {
      localStorage.setItem(AVAILABLE_ONLY_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  return (
    <SearchContext.Provider value={{ query, setQuery, availableOnly, setAvailableOnly }}>
      {children}
    </SearchContext.Provider>
  );
}

export function useOptionalSearch(): BrowseState | null {
  return useContext(SearchContext);
}
