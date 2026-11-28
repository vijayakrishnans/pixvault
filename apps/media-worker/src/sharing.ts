// Public sharing in production waits for CSAM scanning on a serving zone and the product domain (risk PV-A, GAPS G2,
// WAITING W-5/W-6). Until then prod refuses everything that makes a file reachable without signing in: public
// files, public library defaults, the random API, share links, upload links and galleries. Signed links for
// members keep working. Dev and stage keep it on for testing.
//
// PUBLIC_SHARING = "on" | "off". Unset means off in prod, on elsewhere.

import { errorResponse } from "./http.js";

export function publicSharingAllowed(env: { ENVIRONMENT: string; PUBLIC_SHARING?: string }): boolean {
  if (env.PUBLIC_SHARING === "on") return true;
  if (env.PUBLIC_SHARING === "off") return false;
  return env.ENVIRONMENT !== "prod";
}

export function sharingOff(requestId: string): Response {
  return errorResponse("public_sharing_off", "Public sharing isn't available on this service yet. Files stay private; signed links still work.", 409, requestId);
}
