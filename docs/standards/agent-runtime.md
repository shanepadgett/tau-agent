# Agent runtime

Extensions that choose models should request a shared effort tier instead of owning model lists. Each tier resolves to an ordered list of model and thinking-level pairs, with extension-specific workload rules deciding which tier applies.

An extension can request a preferred provider for a workload. The resolver moves that provider's candidates to the front of the selected tier without changing the tier's models or thinking levels. If those candidates are unavailable or fail, resolution continues in the tier's normal provider order.
