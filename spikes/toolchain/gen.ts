// Generates a corpus of Effect-heavy modules for lint and type-check timing.
// Each module has a Schema, a tagged error, a service with a layer that
// depends on the previous module's service, and plain TypeScript helpers.
// Bounded chains reset every eight modules; deep chains keep growing.

export type CorpusShape = "bounded" | "deep"

export const moduleSource = (i: number, shape: CorpusShape): string => {
	const prev = i - 1
	const hasPrev = i > 0 && (shape === "deep" || i % 8 !== 0)
	const importPrev = hasPrev ? `import { Svc${prev}, Item${prev} } from "./m${prev}.ts"\n` : ""
	const parentField = hasPrev ? `\n\tparent: Schema.optional(Item${prev}),` : ""
	const prevYield = hasPrev
		? `\n\t\tconst prev = yield* Svc${prev}`
		: `\n\t\tyield* Effect.logDebug("first module")`
	const prevUse = hasPrev
		? `\n\t\t\tconst siblings = yield* prev.list\n\t\t\tyield* Effect.logDebug("siblings", siblings.length)`
		: ""
	const layerReq = hasPrev ? `Svc${prev}` : "never"

	return `import { Context, Effect, Layer, Schema } from "effect"
${importPrev}
export const Item${i} = Schema.Struct({
	id: Schema.String,
	count: Schema.Finite,
	tags: Schema.Array(Schema.String),
	kind: Schema.Literals(["file", "dir", "link"]),${parentField}
})
export type Item${i} = typeof Item${i}.Type

export class NotFound${i} extends Schema.TaggedError<NotFound${i}>()("NotFound${i}", {
	id: Schema.String,
}) {}

export class Invalid${i} extends Schema.TaggedError<Invalid${i}>()("Invalid${i}", {
	reason: Schema.String,
}) {}

export class Svc${i} extends Context.Service<
	Svc${i},
	{
		readonly get: (id: string) => Effect.Effect<Item${i}, NotFound${i}>
		readonly list: Effect.Effect<ReadonlyArray<Item${i}>>
		readonly put: (input: unknown) => Effect.Effect<Item${i}, Invalid${i}>
		readonly total: Effect.Effect<number>
	}
>()("Svc${i}") {}

const decode${i} = Schema.decodeUnknownEffect(Item${i})

export const Svc${i}Live: Layer.Layer<Svc${i}, never, ${layerReq}> = Layer.effect(
	Svc${i},
	Effect.gen(function* () {${prevYield}
		const store = new Map<string, Item${i}>()

		const get = Effect.fn("Svc${i}.get")(function* (id: string) {
			const item = store.get(id)
			if (item === undefined) return yield* new NotFound${i}({ id })
			return item
		})

		const put = Effect.fn("Svc${i}.put")(function* (input: unknown) {
			const item = yield* decode${i}(input).pipe(
				Effect.mapError((error) => new Invalid${i}({ reason: error.message })),
			)${prevUse}
			store.set(item.id, item)
			return item
		})

		const list = Effect.sync(() => [...store.values()])

		const total = Effect.map(list, (items) => items.reduce((sum, item) => sum + item.count, 0))

		return { get, put, list, total }
	}),
)

export type Shape${i} =
	| { readonly type: "circle"; readonly radius: number }
	| { readonly type: "square"; readonly side: number }
	| { readonly type: "rect"; readonly width: number; readonly height: number }

export const area${i} = (shape: Shape${i}): number => {
	switch (shape.type) {
		case "circle":
			return Math.PI * shape.radius * shape.radius
		case "square":
			return shape.side * shape.side
		case "rect":
			return shape.width * shape.height
	}
}

export const slug${i} = (title: string): string =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")

export const groupBy${i} = <T, K extends string>(items: ReadonlyArray<T>, key: (item: T) => K): Record<K, T[]> => {
	const out = {} as Record<K, T[]>
	for (const item of items) {
		const k = key(item)
		const bucket = out[k] ?? []
		bucket.push(item)
		out[k] = bucket
	}
	return out
}

export const summarize${i} = (items: ReadonlyArray<Item${i}>): string => {
	const byKind = groupBy${i}(items, (item) => item.kind)
	const parts: string[] = []
	for (const [kind, group] of Object.entries(byKind)) {
		parts.push(\`\${kind}: \${group.length}\`)
	}
	return parts.join(", ")
}

export const parseRange${i} = (text: string): { readonly start: number; readonly end: number } | undefined => {
	const match = /^(\\d+)-(\\d+)$/.exec(text.trim())
	if (match === null) return undefined
	const start = Number(match[1])
	const end = Number(match[2])
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
	return { start, end }
}

export const clamp${i} = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export const retryDelays${i} = (attempts: number, base: number): ReadonlyArray<number> =>
	Array.from({ length: attempts }, (_, n) => clamp${i}(base * 2 ** n, base, base * 64))
`
}
