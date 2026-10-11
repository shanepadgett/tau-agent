declare module "markdownlint-cli2" {
	export interface MainParameters {
		/** Arguments, parsed like the command line (globs, --config, --fix, ...). */
		argv?: string[];
		/** Base directory for globs and config discovery. Defaults to process.cwd(). */
		directory?: string;
		/** Error logger; errors are swallowed when omitted. */
		logError?: (message: string) => void;
		/** Message logger; output is suppressed when omitted. */
		logMessage?: (message: string) => void;
		/** Ignore the globs property from configuration; argv paths still apply. */
		noGlobs?: boolean;
	}

	/** Runs markdownlint-cli2. Returns 1 when lint errors remain, 0 otherwise. */
	// fallow-ignore-next-line unused-export -- ambient typing for the external markdownlint-cli2 import used in index.ts
	export const main: (params: MainParameters) => Promise<number>;
}
