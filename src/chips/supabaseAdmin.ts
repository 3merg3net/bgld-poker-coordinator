// src/chips/supabaseAdmin.ts
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// IMPORTANT: load .env.local explicitly (ts-node-dev does NOT auto-load it)
dotenv.config({ path: ".env.local" });


const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

console.log("ENV CHECK", {
  url: !!process.env.SUPABASE_URL,
  key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
});

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in coordinator env"
  );
}

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
