# Test fixtures (vendored, Apache-2.0, unchanged)

| File | Source | sha256 |
|---|---|---|
| `v9_tx_1_2_2.raw` | midnight-indexer `v4.4.0-rc.1` (`668ed025`) `indexer-common/tests/tx_1_2_2.raw` (ledger v9, tag `midnight:transaction[v12]`) | `401a858a91d3aa18e812d979167457b6b1f91ae9b8be7c5721ce4ac47fbd0187` |
| `v9_tx_1_2_3.raw` | midnight-indexer `v4.4.0-rc.1` (`668ed025`) `indexer-common/tests/tx_1_2_3.raw` (ledger v9) | `b4e2768f032d43e716e5c41df403fb9cb0cdced4ac7e34ad9c9974a7eb06d6c7` |
| `v8_tx_1_2_2.raw` | midnight-indexer `v4.3.2` (`7b6d40e0`) `indexer-common/tests/tx_1_2_2.raw` (ledger v8, tag `midnight:transaction[v9]`); used only as a "not ledger v9" input | `80acefb3ccab138490d251c233644b1ab6dcf19fd0fa97da037c95b10dd59a1f` |

The indexer's test (`indexer-common/src/domain/ledger/transaction.rs:473-489`) asserts that
`tx_1_2_2` is relevant to the viewing keys of seeds `00…01` and `00…02` but not `00…03`, and
`tx_1_2_3` to seeds `00…01` and `00…03` but not `00…02`.
