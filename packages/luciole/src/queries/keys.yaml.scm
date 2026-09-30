; Mapping keys named as keys, on top of the YAML queries' `@property`: data reads by its keys.
(block_mapping_pair key: (flow_node (plain_scalar (string_scalar) @string.special.key)))
(block_mapping_pair key: (flow_node [(double_quote_scalar) (single_quote_scalar)] @string.special.key))
(flow_mapping (_ key: (flow_node (plain_scalar (string_scalar) @string.special.key))))
