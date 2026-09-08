import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import type { AuthenticatedRequest, AuthenticatedUser } from "./types";
import { createUserVerifierClient } from "./supabase";

export const bearerToken = (request: Request): string | undefined => {
  const header = request.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface VerifiedTokenClaims {
  aal: "aal1" | "aal2";
  sessionId?: string;
  emailOtpAuthenticatedAt?: number;
}

export const tokenClaims = (token: string): VerifiedTokenClaims => {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      aal?: string;
      session_id?: string;
      amr?: Array<{ method?: unknown; timestamp?: unknown }>;
    };
    const sessionId = typeof payload.session_id === "string"
      && UUID_PATTERN.test(payload.session_id)
      ? payload.session_id
      : undefined;
    const emailOtpAuthenticatedAt = Array.isArray(payload.amr)
      ? payload.amr.reduce<number | undefined>((latest, entry) => {
        if ((entry?.method !== "otp" && entry?.method !== "email/signup")
          || typeof entry.timestamp !== "number"
          || !Number.isSafeInteger(entry.timestamp)
          || entry.timestamp <= 0) return latest;
        return latest == null ? entry.timestamp : Math.max(latest, entry.timestamp);
      }, undefined)
      : undefined;
    return {
      aal: payload.aal === "aal2" ? "aal2" : "aal1",
      sessionId,
      emailOtpAuthenticatedAt
    };
  } catch { return { aal: "aal1" }; }
};

export const createAuthMiddleware = (
  config: AppConfig,
  admin?: SupabaseClient,
  supabase: SupabaseClient | undefined = createUserVerifierClient(config)
) => {
  return async (request: Request, response: Response, next: NextFunction) => {
    const token = bearerToken(request);
    if (token === "local-demo" && config.NODE_ENV !== "production" && config.ENABLE_LOCAL_DEMO === "true") {
      (request as AuthenticatedRequest).user = { id: "local:owner", email: config.OWNER_EMAIL, role: "owner", status: "active", aal: "aal2" };
      next(); return;
    }
    if (!token || !supabase || !admin) {
      response.status(401).json({ error: { code: "unauthorized", message: "A valid session is required." } }); return;
    }
    const { data, error } = await supabase.auth.getClaims(token);
    const verified = data?.claims;
    const expectedIssuer = `${config.SUPABASE_URL?.replace(/\/$/, "")}/auth/v1`;
    const audience = verified?.aud;
    const hasAuthenticatedAudience = audience === "authenticated"
      || (Array.isArray(audience) && audience.includes("authenticated"));
    if (error || !verified || typeof verified.sub !== "string" || !UUID_PATTERN.test(verified.sub)
      || verified.iss !== expectedIssuer || !hasAuthenticatedAudience) {
      response.status(401).json({ error: { code: "unauthorized", message: "The session is invalid or expired." } }); return;
    }
    const claims = tokenClaims(token);
    if (!claims.sessionId) {
      response.status(401).json({ error: { code: "unauthorized", message: "The session is invalid or expired." } }); return;
    }
    const [sessionResult, initialProfileResult] = await Promise.all([
      admin.rpc("goalflow_session_is_active", {
        target_user_id: verified.sub,
        target_session_id: claims.sessionId
      }),
      admin.from("profiles").select("email,role,status")
        .eq("user_id", verified.sub).maybeSingle()
    ]);
    const { data: activeSession, error: sessionError } = sessionResult;
    if (sessionError) {
      response.status(503).json({ error: { code: "session_check_unavailable", message: "Account access could not be verified." } }); return;
    }
    if (activeSession !== true) {
      response.status(401).json({ error: { code: "session_revoked", message: "This session has been signed out." } }); return;
    }
    const authEmail = typeof verified.email === "string" ? verified.email.toLowerCase() : "";
    let { data: profile, error: profileError } = initialProfileResult;
    if (!profile && !profileError && verified.sub === config.OWNER_USER_ID) {
      const bootstrap = await admin.rpc("bootstrap_goalflow_owner", {
        target_user_id: verified.sub,
        target_email: authEmail
      });
      if (bootstrap.error) profileError = bootstrap.error;
      else if (bootstrap.data === true) {
        const result = await admin.from("profiles").select("email,role,status")
          .eq("user_id", verified.sub).maybeSingle();
        profile = result.data; profileError = result.error;
      }
    }
    if (profileError) {
      response.status(503).json({ error: { code: "profile_unavailable", message: "Account access could not be verified." } }); return;
    }
    if (profile && authEmail && profile.email !== authEmail) {
      const { data: updatedProfile, error: updateError } = await admin.from("profiles")
        .update({ email: authEmail, updated_at: new Date().toISOString() })
        .eq("user_id", verified.sub)
        .select("email,role,status")
        .single();
      if (updateError) {
        response.status(409).json({ error: { code: "recovery_email_conflict", message: "This recovery email is already connected to another account." } }); return;
      }
      profile = updatedProfile;
    }
    if (!profile || profile.status !== "active") {
      response.status(403).json({ error: { code: "account_inactive", message: "This Tsurfing account is not active." } }); return;
    }
    if (profile.role === "owner" && config.OWNER_USER_ID && verified.sub !== config.OWNER_USER_ID) {
      response.status(403).json({ error: { code: "account_inactive", message: "This Tsurfing account is not active." } }); return;
    }
    const user: AuthenticatedUser = {
      id: verified.sub,
      email: String(profile.email || authEmail),
      role: profile.role === "owner" ? "owner" : "beta",
      status: "active",
      aal: claims.aal
    };
    (request as AuthenticatedRequest).user = user;
    next();
  };
};

export const requireOwnerMfa = (request: Request, response: Response, next: NextFunction) => {
  if (request.user?.role === "owner" && request.user.aal !== "aal2") {
    response.status(403).json({ error: { code: "mfa_required", message: "Two-factor authentication is required." } }); return;
  }
  next();
};
