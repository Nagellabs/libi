import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { getLibiHome } from "@/lib/libi-home";

export async function GET() {
  return NextResponse.json({
    path: getLibiHome(),
    customPath: process.env.LIBI_HOME || null,
  });
}

export async function POST(request: Request) {
  const { path: customPath } = await request.json();

  // Store in a config file at the default location
  // This will be read on next startup
  const configDir = path.join(os.homedir(), ".libi");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // file doesn't exist or invalid
  }

  if (customPath) {
    config.libiHome = customPath;
  } else {
    delete config.libiHome;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return NextResponse.json({ success: true });
}
