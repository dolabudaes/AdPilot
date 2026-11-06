import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { can, type Permission, type Role } from "@/lib/copilot/permissions";

export const ACTOR_COOKIE = "adpilot_actor";

export type Actor = {
  id: string;
  name: string;
  role: Role;
  title: string;
};

const USER: Actor = {
  id: "user",
  name: "User",
  role: "user",
  title: "Reviews investigations and confirms or dismisses AI recommendations",
};

export function listActors(): Actor[] {
  return [USER];
}

export function getCurrentActor(): Actor {
  try {
    cookies().get(ACTOR_COOKIE);
  } catch {
    // Server components without request context still resolve to the single user.
  }
  return USER;
}

export function actorCan(permission: Permission) {
  return can(getCurrentActor().role, permission);
}

export { can };
export type { Permission, Role };
