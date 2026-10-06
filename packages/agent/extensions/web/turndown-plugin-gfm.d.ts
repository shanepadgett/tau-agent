declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	// fallow-ignore-next-line unused-export -- ambient typing for the external gfm import used in html.ts
	export const gfm: TurndownService.Plugin;
}
