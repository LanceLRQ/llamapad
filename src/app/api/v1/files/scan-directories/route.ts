import { NextResponse } from "next/server";
import { requireAuth } from "@/server/auth";
import { getDb } from "@/server/db";
import { getPathMaps } from "@/server/pathMaps";
import { listScanDirectories } from "@/server/scanDirectoryBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req, getDb());
  if (auth instanceof Response) return auth;

  const dirs = await listScanDirectories(getPathMaps(), new URL(req.url).searchParams.get("path"));
  if (dirs === null) return NextResponse.json({ error: "DIRECTORY_UNAVAILABLE" }, { status: 404 });
  return NextResponse.json({ dirs });
}
