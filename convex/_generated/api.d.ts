/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as attachments from "../attachments.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as automationDefinitions from "../automationDefinitions.js";
import type * as automationScheduler from "../automationScheduler.js";
import type * as automationSchedules from "../automationSchedules.js";
import type * as automations from "../automations.js";
import type * as chats from "../chats.js";
import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as deviceTokens from "../deviceTokens.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as projects from "../projects.js";
import type * as status from "../status.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  attachments: typeof attachments;
  auth: typeof auth;
  authz: typeof authz;
  automationDefinitions: typeof automationDefinitions;
  automationScheduler: typeof automationScheduler;
  automationSchedules: typeof automationSchedules;
  automations: typeof automations;
  chats: typeof chats;
  commands: typeof commands;
  crons: typeof crons;
  deviceTokens: typeof deviceTokens;
  files: typeof files;
  http: typeof http;
  projects: typeof projects;
  status: typeof status;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
