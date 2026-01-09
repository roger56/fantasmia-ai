import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import cookie from "cookie";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Missing password" });
  }

  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    return res.status(500).json({ error: "Admin password not configured" });
  }

  const ok = await bcrypt.compare(password, hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.setHeader(
    "Set-Cookie",
    cookie.serialize("admin_session", "ok", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60 // 1 ora (demo)
    })
  );

  res.status(200).json({ success: true });
}
