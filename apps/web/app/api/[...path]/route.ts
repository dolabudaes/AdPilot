import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_ORIGIN = process.env.API_URL || "http://127.0.0.1:8000";

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const suffix = (ctx.params.path || []).map(encodeURIComponent).join("/");
  const url = new URL(`${API_ORIGIN}/api/${suffix}`);
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "upstream unreachable";
    return NextResponse.json(
      { ok: false, message: `FastAPI unavailable at ${API_ORIGIN}: ${message}` },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) outHeaders.set("content-type", upstreamType);
  const setCookie = upstream.headers.getSetCookie?.() || [];
  for (const item of setCookie) outHeaders.append("set-cookie", item);
  if (!setCookie.length) {
    const single = upstream.headers.get("set-cookie");
    if (single) outHeaders.append("set-cookie", single);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
export async function PUT(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
