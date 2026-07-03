import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/session-cookie";

// Paths reachable without a session.
const PUBLIC_API = ["/api/v1/health", "/api/v1/auth/login", "/api/v1/auth/setup"];
const PUBLIC_PAGES = ["/login", "/setup"];
// Static assets served on the pre-auth login/setup screens (the decorative
// browse showcase artwork under public/showcase/).
const PUBLIC_ASSETS = ["/showcase/"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_API.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (PUBLIC_PAGES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (PUBLIC_ASSETS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const hasApiKey = Boolean(request.headers.get("x-api-key"));

  if (pathname.startsWith("/api/")) {
    // Route handlers validate the session/api key themselves where it matters;
    // this gate just rejects anonymous API traffic outright.
    if (!hasSession && !hasApiKey) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // UI pages: bounce to login (the login page redirects to /setup on first run)
  if (!hasSession) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
