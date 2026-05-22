# INSEE Raw Registry Snapshots

This directory stores source-native or source-shaped INSEE commune observations
used by the registry pipeline.

`fr-cog-communes-27.jsonl` is a scoped authority fixture for the current French
registry slice. It mirrors the INSEE COG identity contract for the 27 French
cities already used by the Wikidata enrichment fixture. The full-country COG
seed will replace this fixture once the registry fetch step is wired.
