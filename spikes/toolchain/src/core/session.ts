import { Context, Effect, Layer } from "effect"

export class Session extends Context.Service<Session, {
	readonly append: (text: string) => Effect.Effect<number>
}>()("Session") {}

export const SessionLive = Layer.sync(Session, () => {
	const entries: string[] = []
	return {
		append: (text: string) => Effect.sync(() => entries.push(text)),
	}
})
