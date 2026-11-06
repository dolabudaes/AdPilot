export type Role = "user";

export type Permission =
  | "read"
  | "analyze"
  | "edit_recommendation"
  | "confirm_decision"
  | "dismiss_decision"
  | "export"
  | "manage_settings"
  | "manage_data"
  | "converse";

export function can(_role: Role, _permission: Permission) {
  return true;
}

export function isRole(value: string): value is Role {
  return value === "user";
}

export function actorRole(_value?: string | null): Role {
  return "user";
}
