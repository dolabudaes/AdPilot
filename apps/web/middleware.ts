import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Product entry: `/` → overview. Legacy product URLs are not kept. */
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname !== "/") return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/overview";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/"],
};
