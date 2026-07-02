import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRequestUser } from "@/server/auth/auth-service";
import { serverError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const user = getRequestUser(request);
    if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    return NextResponse.json(user);
  } catch (err) {
    return serverError(err);
  }
}
