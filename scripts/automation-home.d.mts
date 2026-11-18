export declare const AUTOMATION_HOME_ENV: "CLONE_AI_AUTOMATION_HOME";
export declare const ALLOW_OWNER_HOME_ENV: "CLONE_AI_ALLOW_OWNER_HOME";
export declare const REFRESH_ENV: "CLONE_AI_AUTOMATION_REFRESH";
export declare const SEEDED_FILES: readonly string[];

export interface AutomationHomeOptions {
  repoRoot: string;
  purpose?: string;
  ownerDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AutomationHome {
  dataDirectory: string;
  ownerDirectory: string;
  purpose: string;
}

export interface PreparedAutomationHome extends AutomationHome {
  seeded: string[];
}

export declare function ownerCloneHome(env?: NodeJS.ProcessEnv): string;
export declare function resolveAutomationHome(options: AutomationHomeOptions): AutomationHome;
export declare function prepareAutomationHome(options: AutomationHomeOptions): Promise<PreparedAutomationHome>;
