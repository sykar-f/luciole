; Keys named as keys, on top of the TOML queries' `@property`: data reads by its keys.
(pair (bare_key) @string.special.key)
(pair (quoted_key) @string.special.key)
(pair (dotted_key (bare_key) @string.special.key))
(table (bare_key) @string.special.key)
