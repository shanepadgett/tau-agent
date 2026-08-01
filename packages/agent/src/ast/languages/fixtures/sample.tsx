import type { ReactNode } from "react";

export type Props = {
	name: string;
	children?: ReactNode;
};

/** Landing page shell. */
export function CatalogLanding({ name, children }: Props) {
	return (
		<main className="catalog">
			<h1>{name}</h1>
			{children}
		</main>
	);
}

export const STATE: Readonly<Record<string, string>> = {
	draft: "Draft",
	delivery: "Delivery",
};

export const CatalogPage = define.page(async function CatalogPage({ state }) {
	const catalog = await loadCatalog(state);
	return <main>{catalog.name}</main>;
});

export default function DefaultPage() {
	return <CatalogLanding name="home" />;
}

class PrivateWidget {
	render() {
		return <span />;
	}
}
