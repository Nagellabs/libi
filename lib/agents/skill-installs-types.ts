import type { SetupAgentId } from "@/lib/agents/setup/commands";

/**
 * Shapes shared by the install service, its routes, the React Query hooks, the
 * Agents page and `libi connect`. No Node imports: this file is bundled into
 * the client.
 */
export type SkillInstallScope = "user" | "folder";
export type SkillInstallSource = "ui" | "cli";
export type SkillInstallStatus = "up-to-date" | "folder-not-found" | "error";

export interface SkillInstallView {
  id: string;
  agentId: SetupAgentId;
  scope: SkillInstallScope;
  /** The skills root shown to the user: the agent's user dir, or `<folder>/<dialect>`. */
  path: string;
  folderPath: string | null;
  source: SkillInstallSource;
  status: SkillInstallStatus;
  error: string | null;
  /** Skills libi did not write because a dir of that name already existed and was not libi's. */
  skippedNames: string[];
  /** Names in the root's manifest at read time. */
  installedCount: number;
  lastSyncedAt: string | null;
}

export type AddSkillInstallInput =
  | { agentId: SetupAgentId; scope: "user"; source: SkillInstallSource }
  | { agentId: SetupAgentId; scope: "folder"; folderPath: string; source: SkillInstallSource };

export type InstallFolderError =
  | "not_absolute"
  | "not_found"
  | "not_directory"
  | "not_writable"
  | "refused_home"
  | "refused_root"
  | "refused_libi_home";

/** `invalid_body` and `install_failed` are route-level failures (bad request JSON, an
 *  unexpected 500) rather than an install-service decision; `not_found` (also part of
 *  `InstallFolderError`) is what DELETE answers for an id that's already gone. */
export type SkillInstallErrorCode =
  | InstallFolderError
  | "user_level_installed"
  | "linked_to_libi"
  | "unknown_agent"
  | "invalid_body"
  | "install_failed";

export const INSTALL_FOLDER_MESSAGES: Record<InstallFolderError, string> = {
  not_absolute: "Enter the folder's full path.",
  not_found: "That folder doesn't exist.",
  not_directory: "That path isn't a folder.",
  not_writable: "libi can't write to that folder.",
  refused_home: "That's your home folder. To install libi's skills for every folder, choose Every folder.",
  refused_root: "Choose a project folder, not the root of the disk.",
  refused_libi_home: "That folder is libi's own data folder. libi's own chats and terminal already have libi's skills.",
};

export const USER_LEVEL_INSTALLED_MESSAGE = "Skills are installed for every folder, so every folder already has them.";

/** A user-level add (or an existing row found in this state at sync time) whose root resolves,
 *  through a link, into libi's own agent dir: writing there would have libi's own-dir refresh
 *  write the dialect straight back through the same link on the next Remove, leaving the skills
 *  visible at user level while the card reads "Not installed". */
export const LINKED_TO_LIBI_MESSAGE =
  "libi's skills folder for every folder links into libi's own agent folder. Remove that link, then install again.";

export interface SkillInstallsResponse {
  installs: SkillInstallView[];
  /** Per agent, the resolved user-level dir as copy shows it (`~/…` under home). */
  userSkillsDirs: Record<SetupAgentId, string>;
}
